/**
 * Installs the Waterboy service that ships inside the app (Contents/Resources/agent) as the
 * launchd job local.waterboy, and keeps it pointing at this copy of the app after updates or moves.
 *
 * Only the packaged app does this. A service installed from a source checkout (`npm run
 * install-service` in waterboy-agent) is left alone until the user asks to switch (adopt()).
 * The bundled service keeps its config in ~/.imessage-agent/config.json, since the app bundle is read-only.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const run = promisify(execFile);
const LABEL = "local.waterboy";
const LEGACY_LABEL = "local.imessage-agent"; // before the Waterboy rename; replaced on install
const plistFor = (label) => path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`);
const UID = process.getuid();
const DATA_DIR = path.join(os.homedir(), ".imessage-agent");

/** Where this app's copy of the service is, or null when running from source or from somewhere it can't be installed. */
function bundle({ resourcesPath, execPath, version }) {
  const agentDir = path.join(resourcesPath, "agent");
  if (!fs.existsSync(path.join(agentDir, "run.sh"))) return null;
  const appPath = execPath.replace(/\/Contents\/MacOS\/[^/]+$/, "");
  // A service pointing into a mounted DMG or a Gatekeeper-translocated copy breaks when that goes away.
  let blocked = null;
  if (appPath.startsWith("/Volumes/")) blocked = "Move Waterboy to your Applications folder, then open it from there to set up the service.";
  else if (appPath.includes("/AppTranslocation/")) blocked = "Move Waterboy to your Applications folder (drag it there in Finder), then open it again to set up the service.";
  return { agentDir, execPath, appPath, version, blocked };
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The LaunchAgent for the bundled service. Same shape as waterboy-agent/scripts/install-launchd.sh. */
function plistXml(b, { home = os.homedir() } = {}) {
  const data = path.join(home, ".imessage-agent");
  const env = {
    WATERBOY_BIN: b.execPath,
    WATERBOY_VERSION: b.version,
    IMESSAGE_AGENT_CONFIG: path.join(data, "config.json"),
    HOME: home,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${xml(path.join(b.agentDir, "run.sh"))}</string></array>
  <key>WorkingDirectory</key><string>${xml(b.agentDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(path.join(data, "logs/agent.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(data, "logs/agent.err.log"))}</string>
</dict>
</plist>
`;
}

async function readPlist(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const { stdout } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]);
    return JSON.parse(stdout);
  } catch {
    return {};
  }
}

/** What's installed now: nothing, the bundled service (from which app/version), or a source checkout. */
async function installed() {
  for (const label of [LABEL, LEGACY_LABEL]) {
    const p = await readPlist(plistFor(label));
    if (!p) continue;
    const script = p.ProgramArguments?.[1] ?? "";
    if (/\.app\/Contents\/Resources\/agent\/run\.sh$/.test(script))
      return { kind: "bundled", label, runScript: script, version: p.EnvironmentVariables?.WATERBOY_VERSION ?? null };
    return { kind: "source", label, project: p.WorkingDirectory ?? null, configPath: p.EnvironmentVariables?.IMESSAGE_AGENT_CONFIG ?? null };
  }
  return { kind: "none" };
}

const isLoaded = (label) =>
  run("/bin/launchctl", ["print", `gui/${UID}/${label}`]).then(
    () => true,
    () => false,
  );

/** Seed ~/.imessage-agent/config.json from the example (without its sample chats and league) if there isn't one. */
function seedConfig(b, fromProjectConfig = null) {
  const target = path.join(DATA_DIR, "config.json");
  fs.mkdirSync(path.join(DATA_DIR, "logs"), { recursive: true });
  if (fs.existsSync(target)) return false;
  if (fromProjectConfig && fs.existsSync(fromProjectConfig)) {
    const cfg = JSON.parse(fs.readFileSync(fromProjectConfig, "utf8"));
    // The old config may point dataDir elsewhere; the bundled service always reads this file, so keep its data where it was.
    fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    return true;
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(b.agentDir, "config.example.json"), "utf8"));
  Object.assign(cfg, { allowedChats: [], contacts: {}, groupAdmins: [], fantasy: null });
  fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return true;
}

/** Write the LaunchAgent and (re)load it. `start: false` rewrites it without starting a paused service. */
async function writeAndLoad(b, { start = true } = {}) {
  const plist = plistFor(LABEL);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  for (const label of [LABEL, LEGACY_LABEL]) await run("/bin/launchctl", ["bootout", `gui/${UID}/${label}`]).catch(() => {});
  fs.rmSync(plistFor(LEGACY_LABEL), { force: true });
  fs.writeFileSync(`${plist}.tmp`, plistXml(b));
  fs.renameSync(`${plist}.tmp`, plist);
  if (!start) return;
  // bootout returns before the old process exits (it finishes in-flight replies first), and
  // bootstrapping too early fails with "Bad request", so wait for it to be gone.
  for (let i = 0; i < 40 && ((await isLoaded(LABEL)) || (await isLoaded(LEGACY_LABEL))); i++) await new Promise((r) => setTimeout(r, 500));
  await run("/bin/launchctl", ["bootstrap", `gui/${UID}`, plist]);
  await run("/bin/launchctl", ["enable", `gui/${UID}/${LABEL}`]).catch(() => {});
}

/**
 * On launch of the packaged app: install the service if there is none, and re-point / restart it
 * if it's the bundled service from another version or location of the app. Leaves a
 * source-checkout service alone. Returns what happened, for the dashboard.
 */
async function ensure(b) {
  if (!b) return { state: "unbundled" };
  const cur = await installed();
  if (cur.kind === "source") return { state: "source", project: cur.project };
  if (b.blocked) return { state: "blocked", reason: b.blocked, installed: cur.kind !== "none" };
  if (cur.kind === "none") {
    seedConfig(b);
    await writeAndLoad(b);
    return { state: "installed" };
  }
  const ours = path.join(b.agentDir, "run.sh");
  if (cur.label === LABEL && cur.runScript === ours && cur.version === b.version) return { state: "current" };
  // An update or a moved app: keep a paused service paused.
  const wasLoaded = await isLoaded(cur.label);
  seedConfig(b);
  await writeAndLoad(b, { start: wasLoaded });
  return { state: "updated", from: cur.version };
}

/** Switch from a source-checkout service to the bundled one, carrying its config.json over. */
async function adopt(b) {
  if (!b) throw new Error("This copy of Waterboy doesn't include the service.");
  if (b.blocked) throw new Error(b.blocked);
  const cur = await installed();
  seedConfig(b, cur.kind === "source" ? cur.configPath || (cur.project && path.join(cur.project, "config.json")) : null);
  await writeAndLoad(b);
  return { state: "installed" };
}

module.exports = { bundle, plistXml, installed, ensure, adopt, LABEL };
