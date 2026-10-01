/**
 * Everything the Waterboy desktop app knows about the Waterboy service (../waterboy-agent): where it lives, its
 * launchd job, config.json, state.db (automations, per-chat sessions), logs, per-chat memory,
 * and the recent-chats index the service writes. Runs in Electron's main process only.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const { Cron } = require("croner");
const { parseLog, summarize } = require("./logs");

const run = promisify(execFile);
// launchd job. Macs set up before the Waterboy rename still have the old label until
// `npm run install-service` is run again, so fall back to it.
const LABELS = ["local.waterboy", "local.imessage-agent"];
const plistFor = (label) => path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`);
const LABEL_NOW = () => LABELS.find((l) => fs.existsSync(plistFor(l))) ?? LABELS[0];
let LABEL = LABEL_NOW();
let PLIST = plistFor(LABEL);
function refreshLabel() {
  LABEL = LABEL_NOW();
  PLIST = plistFor(LABEL);
}
const UID = process.getuid();
const expand = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

// ---------- locations ----------

/** Project dir and config path come from the LaunchAgent the service was installed with. */
async function locate() {
  refreshLabel();
  let project = process.env.IMESSAGE_AGENT_DIR || path.resolve(__dirname, "../../waterboy-agent");
  let configPath = null;
  // IMESSAGE_AGENT_DIR wins over the installed service (also keeps tests off the real data).
  if (!process.env.IMESSAGE_AGENT_DIR && fs.existsSync(PLIST)) {
    try {
      const { stdout } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", PLIST]);
      const plist = JSON.parse(stdout);
      if (plist.WorkingDirectory) project = plist.WorkingDirectory;
      configPath = plist.EnvironmentVariables?.IMESSAGE_AGENT_CONFIG ?? null;
    } catch {}
  }
  configPath = configPath || path.join(project, "config.json");
  const cfg = readJson(configPath) ?? {};
  const dataDir = expand(cfg.dataDir || "~/.imessage-agent");
  return {
    project,
    configPath,
    dataDir,
    plist: PLIST,
    plistInstalled: fs.existsSync(PLIST),
    logFile: path.join(dataDir, "logs/agent.log"),
    errFile: path.join(dataDir, "logs/agent.err.log"),
    stateDb: path.join(dataDir, "state.db"),
    chatsDir: path.join(dataDir, "chats"),
    chatIndex: path.join(dataDir, "chats-index.json"),
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------- config.json ----------

async function getConfig() {
  const loc = await locate();
  const cfg = readJson(loc.configPath);
  if (!cfg)
    throw new Error(
      loc.plistInstalled
        ? `Can't read the agent's config at ${loc.configPath}.`
        : "The Waterboy service isn't set up on this Mac yet. In the waterboy-agent project, create config.json and run npm run install-service, then reopen this app.",
    );
  return cfg;
}

/**
 * Apply `mutate` to config.json and write it back (keys and order preserved). Writes to a
 * temp file first so a crash never leaves the service with half a config.
 */
async function updateConfig(mutate) {
  const loc = await locate();
  const cfg = readJson(loc.configPath);
  if (!cfg) throw new Error(`Can't read ${loc.configPath}`);
  mutate(cfg);
  const text = JSON.stringify(cfg, null, 2) + "\n";
  JSON.parse(text);
  fs.writeFileSync(`${loc.configPath}.tmp`, text);
  fs.renameSync(`${loc.configPath}.tmp`, loc.configPath);
  return cfg;
}

// Handles compare on their last 10 digits (phone numbers) or lowercase (emails), like the service.
function normalizeHandle(h) {
  const s = String(h).trim().toLowerCase();
  if (s.includes("@")) return s;
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : s;
}
const sameHandle = (a, b) => a === b || normalizeHandle(a) === normalizeHandle(b);
const findKey = (obj, handle) => Object.keys(obj ?? {}).find((k) => sameHandle(k, handle));

// ---------- service (launchd) ----------

async function serviceStatus() {
  const loc = await locate();
  if (!loc.plistInstalled) return { installed: false, running: false, pid: null, startedAt: null };
  try {
    const { stdout } = await run("/bin/launchctl", ["print", `gui/${UID}/${LABEL}`]);
    const pid = Number(stdout.match(/^\s*pid = (\d+)/m)?.[1]) || null;
    const running = /^\s*state = running/m.test(stdout) && !!pid;
    let startedAt = null;
    if (pid) {
      const { stdout: ps } = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)]).catch(() => ({ stdout: "" }));
      const t = Date.parse(ps.trim());
      if (Number.isFinite(t)) startedAt = new Date(t).toISOString();
    }
    const lastExit = stdout.match(/last exit code = (-?\d+)/)?.[1] ?? null;
    return { installed: true, loaded: true, running, pid, startedAt, lastExit };
  } catch {
    return { installed: true, loaded: false, running: false, pid: null, startedAt: null };
  }
}

/** Start (load) the service, or restart it if it's already loaded. */
async function startService() {
  const s = await serviceStatus();
  if (!s.installed) throw new Error("The service isn't installed. Run `npm run install-service` in the agent project.");
  if (!s.loaded) await run("/bin/launchctl", ["bootstrap", `gui/${UID}`, PLIST]);
  else await run("/bin/launchctl", ["kickstart", "-k", `gui/${UID}/${LABEL}`]);
  return waitFor((st) => st.running);
}

/** Pause = unload the job, so it neither replies nor runs automations (it loads again at login). */
async function pauseService() {
  await run("/bin/launchctl", ["bootout", `gui/${UID}/${LABEL}`]).catch((e) => {
    if (!/No such process|not find|Could not find/i.test(String(e.stderr ?? e.message))) throw e;
  });
  return waitFor((st) => !st.running);
}

async function restartService() {
  return startService();
}

async function waitFor(ok, ms = 12_000) {
  const until = Date.now() + ms;
  let st = await serviceStatus();
  while (!ok(st) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
    st = await serviceStatus();
  }
  return st;
}

// ---------- readiness ----------

async function readiness() {
  const loc = await locate();
  const cfg = readJson(loc.configPath) ?? {};
  const envFile = path.join(loc.dataDir, "env");
  const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";

  // Sign-in for the chosen assistant. Claude: a setup-token in the service env file, or Claude
  // Code's own login in the Keychain (checked without reading the secret). ChatGPT: Waterboy's own
  // Codex home (see chatgptAccount).
  let claude = { ok: false, detail: "Not signed in" };
  if (providerOf(cfg) === "chatgpt") {
    const acct = chatgptAccount(loc);
    claude = acct.signedIn ? { ok: true, detail: `Signed in${acct.plan ? ` (${planName(acct.plan)} plan)` : ""}` } : { ok: false, detail: "Not signed in" };
  } else if (/^\s*CLAUDE_CODE_OAUTH_TOKEN=\S+/m.test(env)) claude = { ok: true, detail: "Long-lived token" };
  else if (/^\s*ANTHROPIC_API_KEY=\S+/m.test(env)) claude = { ok: true, detail: "API key (billed to the API)" };
  else {
    const found = await run("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials"])
      .then(() => true)
      .catch(() => false);
    if (found) claude = { ok: true, detail: "Signed in" };
  }

  // Messages access: the service can only write the chat index if it can read chat.db. A past
  // failure stays in the error log after the user grants access, so an index written since the
  // last error means access works now.
  const err = tail(loc.errFile, 4000);
  const idx = readJson(loc.chatIndex);
  const denied = /Full Disk Access|Cannot read .*chat\.db/i.test(err.split("\n").slice(-6).join("\n"));
  let messages;
  if (denied && !(mtime(loc.chatIndex) > mtime(loc.errFile)))
    messages = { ok: false, detail: "Needs Full Disk Access" };
  else if (idx) messages = { ok: true, detail: "Ready" };
  else messages = { ok: false, detail: "Waiting for the agent" };

  const n = (cfg.allowedChats ?? []).length;
  const health = readJson(path.join(loc.dataDir, "health.json"));
  return {
    provider: providerOf(cfg),
    claude,
    messages,
    conversations: { ok: n > 0, detail: n ? `${n} allowed` : "None allowed" },
    sending: sendingReadiness(health),
    automation: automationReadiness(health),
    checks: serviceChecks(health),
    sources: sourcesReadiness(health),
  };
}

/** The service rewrites health.json at least every 10 min while it runs */
const HEALTH_STALE_MS = 30 * 60_000;

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * Sending through Messages, from the service's health.json (records every
 * send and probes Messages every 10 min without sending). `failing` also
 * drives the Dashboard banner.
 */
function sendingReadiness(health, now = Date.now()) {
  const send = health?.send;
  if (!send) return { ok: true, failing: false, detail: "Not checked yet" };
  if (now - (health.updatedAt ?? 0) > HEALTH_STALE_MS) return { ok: true, failing: false, detail: "Not checked recently (is the service running?)" };
  if (send.status === "failing") {
    const why = send.probe && !send.probe.ok
      ? send.probe.detail
      : send.lastFailure?.timedOut
        ? "Messages didn't respond"
        : send.lastFailure?.message ?? "Sends are failing";
    const count = send.consecutiveFailures > 1 ? `The last ${send.consecutiveFailures} sends failed. ` : "";
    return { ok: false, failing: true, detail: `${count}${why}` };
  }
  if (send.status === "degraded") return { ok: true, failing: false, detail: `One send failed at ${clock(send.lastFailure.at)}; retrying on the next reply` };
  if (send.status === "ok") return { ok: true, failing: false, detail: send.lastOkAt ? `Working (last sent ${clock(send.lastOkAt)})` : "Messages responds" };
  return { ok: true, failing: false, detail: "No sends yet" };
}

/** The service's setup checks (the same ones `npm run doctor` runs) that need attention */
function serviceChecks(health, now = Date.now()) {
  if (!Array.isArray(health?.checks) || now - (health.updatedAt ?? 0) > HEALTH_STALE_MS) return null;
  return {
    checkedAt: health.updatedAt,
    total: health.checks.length,
    attention: health.checks
      .filter((c) => c.status !== "pass")
      .map((c) => ({ label: c.label, detail: c.detail, hint: c.hint ?? null, ok: c.status !== "fail" || !c.required })),
  };
}

// The service's data sources (health.json `sources`, v0.4), in Dashboard order, with the Settings →
// Fantasy control that turns each on or off (ESPN has no switch, so it points at the league id).
const SOURCES = [
  { id: "espn", label: "ESPN Fantasy", setting: "fantasy.espnLeagueId" },
  { id: "sleeper", label: "Sleeper", setting: "fantasy.sleeper" },
  { id: "nflverse", label: "nflverse stats", setting: "fantasy.nflverse" },
  { id: "lines", label: "ESPN scoreboard and lines", setting: "fantasy.vegas" },
  { id: "rankings", label: "FantasyPros rankings", setting: "fantasy.rankings" },
  { id: "tradeValues", label: "FantasyCalc trade values", setting: "fantasy.tradeValues" },
];
const SOURCE_STATES = ["ok", "degraded", "down", "off", "unknown"];
/** nflverse rebuilds daily; files older than this mean the download keeps failing */
const NFLVERSE_STALE_MS = 48 * 3600_000;

/**
 * Data-source health from health.json. null when the service doesn't report it (before v0.4) or
 * when no fantasy source is on; `stale` when the file is too old to trust. The service keeps the
 * numbers in memory, so after a restart sources are "unknown" until they're used again.
 */
function sourcesReadiness(health, now = Date.now()) {
  const raw = health?.sources;
  if (!raw || typeof raw !== "object") return null;
  if (now - (health.updatedAt ?? 0) > HEALTH_STALE_MS) return { stale: true, list: [], down: [] };
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const list = SOURCES.map((src) => {
    const x = raw[src.id] ?? {};
    const status = SOURCE_STATES.includes(x.status) ? x.status : "unknown";
    const dataUpdatedAt = num(x.dataUpdatedAt);
    return {
      ...src,
      status,
      lastOkAt: num(x.lastOkAt),
      lastError: typeof x.lastError === "string" && x.lastError ? x.lastError : null,
      lastErrorAt: num(x.lastErrorAt),
      okRate24h: num(x.okRate24h),
      calls24h: num(x.calls24h) ?? 0,
      avgMs: num(x.avgMs),
      ...(src.id === "nflverse" ? { dataUpdatedAt, dataStale: dataUpdatedAt !== null && now - dataUpdatedAt > NFLVERSE_STALE_MS } : {}),
    };
  });
  if (list.every((s) => s.status === "off")) return null;
  return {
    stale: false,
    checkedAt: health.updatedAt,
    startedAt: num(health.startedAt),
    list,
    // Off sources never count: only enabled ones that are down
    down: list.filter((s) => s.status === "down").map((s) => s.label),
  };
}

/**
 * Why the service refused to start (startup-error.json, e.g. data from a newer Waterboy after a
 * rollback). The service removes the file once it starts normally.
 */
function startupError(loc) {
  const e = readJson(path.join(loc.dataDir, "startup-error.json"));
  return e && typeof e.message === "string" ? { message: e.message, at: e.at ?? null } : null;
}

/** Automation → Messages, from the service's own check in health.json; null until it has run */
function automationReadiness(health, now = Date.now()) {
  if (!Array.isArray(health?.checks) || now - (health.updatedAt ?? 0) > HEALTH_STALE_MS) return null;
  const c = health.checks.find((x) => x.id === "automation");
  if (!c || c.skipped) return null;
  return { ok: c.status !== "fail", detail: c.status === "pass" ? "Allowed" : c.detail };
}

/** Last-modified time in ms, or 0 when the file is missing. */
function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function tail(file, bytes) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    const len = Math.min(bytes, st.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

// ---------- logs ----------

async function logs() {
  const loc = await locate();
  const events = parseLog(tail(loc.logFile, 512 * 1024));
  const errors = tail(loc.errFile, 16 * 1024)
    .split("\n")
    .filter((l) => l.trim())
    .slice(-50);
  const summary = summarize(events);
  return { events: events.reverse(), errors, summary, logFile: loc.logFile };
}

// ---------- chats ----------

function chatDirName(guid) {
  return guid.replace(/[^\w.+@-]+/g, "_"); // same rule as the service's Bot.chatDir
}

/** Conversations: recent chats from the service's index, merged with the config allowlist. */
async function conversations() {
  const loc = await locate();
  const cfg = readJson(loc.configPath) ?? {};
  const idx = readJson(loc.chatIndex) ?? { chats: [] };
  const allowed = cfg.allowedChats ?? [];
  const contacts = cfg.contacts ?? {};
  const teams = cfg.fantasy?.teams ?? {};
  const admins = cfg.groupAdmins ?? [];
  const access = cfg.chatAccess ?? {};
  const nameFor = (h) => contacts[findKey(contacts, h)] ?? null;
  const isAllowed = (keys) => allowed.some((a) => keys.some((k) => k && (a.toLowerCase() === k.toLowerCase() || sameHandle(a, k))));

  const direct = [];
  const groups = [];
  const seen = new Set();
  for (const c of idx.chats) {
    if (c.isGroup) {
      groups.push({
        guid: c.guid,
        identifier: c.identifier,
        name: c.name,
        members: c.members.map((m) => ({ handle: m, name: nameFor(m) })),
        allowed: isAllowed([c.guid, c.identifier, c.name]),
        lastMessageAt: c.lastMessageAt,
      });
    } else {
      const handle = c.identifier;
      if ([...seen].some((s) => sameHandle(s, handle))) continue;
      seen.add(handle);
      direct.push(directRow(handle, c.guid, c.lastMessageAt));
    }
  }
  // Allowlisted handles that haven't messaged recently.
  for (const a of allowed) {
    if (a.includes(";") || groups.some((g) => [g.guid, g.identifier, g.name].includes(a))) continue;
    if ([...seen].some((s) => sameHandle(s, a))) continue;
    seen.add(a);
    direct.push(directRow(a, null, null));
  }
  return { direct, groups, indexUpdatedAt: idx.updatedAt ?? null };

  function directRow(handle, guid, lastMessageAt) {
    const teamKey = findKey(teams, handle);
    return {
      handle,
      guid,
      name: nameFor(handle),
      allowed: isAllowed([handle, guid]),
      admin: admins.some((a) => sameHandle(a, handle)),
      team: teamKey ? teams[teamKey] : null,
      access: access[findKey(access, handle)] === "fantasy" ? "fantasy" : "full",
      lastMessageAt,
    };
  }
}

async function setAllowed(key, allowed) {
  return updateConfig((cfg) => {
    const list = cfg.allowedChats ?? [];
    const rest = list.filter((a) => !(a === key || (!key.includes(";") && sameHandle(a, key))));
    cfg.allowedChats = allowed ? [...rest, key] : rest;
  });
}

async function setContactName(handle, name) {
  return updateConfig((cfg) => {
    cfg.contacts = cfg.contacts ?? {};
    const k = findKey(cfg.contacts, handle) ?? handle;
    if (name && name.trim()) cfg.contacts[k] = name.trim();
    else delete cfg.contacts[k];
  });
}

async function setAdmin(handle, admin) {
  return updateConfig((cfg) => {
    const rest = (cfg.groupAdmins ?? []).filter((a) => !sameHandle(a, handle));
    cfg.groupAdmins = admin ? [...rest, handle] : rest;
  });
}

/** "full" (every tool) or "fantasy" (fantasy football only) for a person's 1:1 chat. */
async function setAccess(handle, level) {
  if (!["full", "fantasy"].includes(level)) throw new Error(`Unknown access level ${level}`);
  return updateConfig((cfg) => {
    cfg.chatAccess = cfg.chatAccess ?? {};
    const k = findKey(cfg.chatAccess, handle) ?? handle;
    if (level === "fantasy") cfg.chatAccess[k] = "fantasy";
    else delete cfg.chatAccess[k];
    if (!Object.keys(cfg.chatAccess).length) delete cfg.chatAccess;
  });
}

async function setTeam(handle, team) {
  return updateConfig((cfg) => {
    if (!cfg.fantasy) throw new Error("Fantasy football isn't configured.");
    cfg.fantasy.teams = cfg.fantasy.teams ?? {};
    const k = findKey(cfg.fantasy.teams, handle) ?? handle;
    if (team) cfg.fantasy.teams[k] = team;
    else delete cfg.fantasy.teams[k];
  });
}

/** Team names from the ESPN league, for the team picker. */
/**
 * A phone number or email as Messages uses it: "(614) 555-0142" → "+16145550142", emails lowercased.
 * Throws on anything that isn't one.
 */
function cleanHandle(raw) {
  const s = String(raw ?? "").trim();
  if (s.includes("@")) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error(`"${s}" isn't a valid email address.`);
    return s.toLowerCase();
  }
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  throw new Error(`"${s}" isn't a phone number. Use 10 digits, or +country code for numbers outside the US.`);
}

/**
 * Add someone who can text the agent (or update them if they're already listed): allowed, named,
 * with an access level and optionally their fantasy team. One config write.
 */
async function addPerson({ name, handle, access = "full", team = null } = {}) {
  const clean = cleanHandle(handle);
  const label = String(name ?? "").trim();
  if (!label) throw new Error("Enter a name.");
  if (!["full", "fantasy"].includes(access)) throw new Error(`Unknown access level ${access}`);
  let existed = false;
  await updateConfig((cfg) => {
    if (team && !cfg.fantasy) throw new Error("Fantasy football isn't configured, so there's no team to set.");
    const allowed = cfg.allowedChats ?? [];
    const key = allowed.find((a) => !a.includes(";") && sameHandle(a, clean)) ?? clean;
    existed = allowed.includes(key);
    if (!existed) cfg.allowedChats = [...allowed, key];
    cfg.contacts = cfg.contacts ?? {};
    cfg.contacts[findKey(cfg.contacts, key) ?? key] = label;
    const accessKey = findKey(cfg.chatAccess, key);
    if (access === "fantasy") (cfg.chatAccess = cfg.chatAccess ?? {})[accessKey ?? key] = "fantasy";
    else if (accessKey) {
      delete cfg.chatAccess[accessKey];
      if (!Object.keys(cfg.chatAccess).length) delete cfg.chatAccess;
    }
    if (cfg.fantasy) {
      const teams = (cfg.fantasy.teams = cfg.fantasy.teams ?? {});
      const teamKey = findKey(teams, key);
      if (team) teams[teamKey ?? key] = String(team);
      else if (teamKey) delete teams[teamKey];
    }
  });
  return { handle: clean, name: label, access, team: team || null, updated: existed };
}

async function fantasyTeams() {
  const cfg = await getConfig();
  const f = cfg.fantasy;
  if (!f?.espnLeagueId) return [];
  const season = f.season ?? new Date().getFullYear();
  const headers = { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Macintosh) waterboy-desktop/0.1" };
  if (f.espnS2 && f.swid) headers.Cookie = `espn_s2=${f.espnS2}; SWID=${f.swid}`;
  const res = await fetch(
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${f.espnLeagueId}?view=mTeam`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  const d = await res.json();
  return d.teams.map((t) => ({ id: t.id, name: (t.name || t.abbrev).replace(/\s+/g, " ").trim() }));
}

// ---------- state.db: automations + sessions ----------

async function withDb(fn, { write = false } = {}) {
  const loc = await locate();
  if (!fs.existsSync(loc.stateDb)) throw new Error("The agent hasn't created its database yet. Start it once first.");
  const db = new DatabaseSync(loc.stateDb, { readOnly: !write });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    return fn(db);
  } finally {
    db.close();
  }
}

async function automations() {
  const conv = await conversations();
  const label = chatLabeler(conv);
  const rows = await withDb((db) => db.prepare("SELECT * FROM tasks ORDER BY enabled DESC, id").all());
  return rows.map((r) => ({
    id: Number(r.id),
    chatGuid: r.chat_guid,
    chatLabel: label(r.chat_guid),
    schedule: r.schedule,
    scheduleText: describeSchedule(r.schedule),
    description: r.description,
    prompt: r.prompt,
    nextRun: r.next_run === null ? null : new Date(Number(r.next_run)).toISOString(),
    condition: r.condition ?? null,
    enabled: !!r.enabled,
    createdAt: new Date(Number(r.created_at)).toISOString(),
  }));
}

function chatLabeler(conv) {
  return (guid) => {
    const g = conv.groups.find((x) => x.guid === guid);
    if (g) return g.name || "Group chat";
    const handle = guid.split(";").pop();
    const d = conv.direct.find((x) => x.guid === guid || sameHandle(x.handle, handle));
    return d?.name ? `${d.name} (${d.handle})` : handle;
  };
}

function nextRunFor(schedule) {
  if (/^\d{4}-\d{2}-\d{2}T/.test(schedule)) {
    const t = Date.parse(schedule);
    if (!Number.isFinite(t)) throw new Error("That date isn't valid.");
    return t > Date.now() ? t : null;
  }
  const next = new Cron(schedule, { paused: true }).nextRun();
  return next ? next.getTime() : null;
}

/** The condition that drives live scoring alerts (see waterboy-agent/src/bot/conditions.ts). */
const ALERT_CONDITION = "fantasy_scoring_swing";

/** Named gates the service checks before a run (waterboy-agent src/conditions.ts). */
const CONDITIONS = ["fantasy_week_final", ALERT_CONDITION];

function checkAutomation({ chatGuid, schedule, prompt, condition }) {
  if (!chatGuid || !schedule?.trim() || !prompt?.trim()) throw new Error("Pick a conversation, a schedule and an instruction.");
  if (condition && !CONDITIONS.includes(condition)) throw new Error(`Unknown condition ${condition}`);
  let next;
  try {
    next = nextRunFor(schedule.trim());
  } catch (e) {
    throw new Error(`Schedule not understood: ${e.message}`);
  }
  if (next === null) throw new Error("That schedule never runs in the future.");
  return next;
}

async function createAutomation({ chatGuid, description, schedule, prompt, condition = null }) {
  const next = checkAutomation({ chatGuid, schedule, prompt, condition });
  return withDb(
    (db) =>
      Number(
        db
          .prepare(
            "INSERT INTO tasks (chat_guid, schedule, prompt, description, next_run, enabled, created_at, condition) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
          )
          .run(chatGuid, schedule.trim(), prompt.trim(), (description || prompt).trim().slice(0, 120), next, Date.now(), condition || null).lastInsertRowid,
      ),
    { write: true },
  );
}

/**
 * Change an automation in place (the service reads tasks from state.db on every tick, so no
 * restart is needed). The next run is only recalculated when the schedule changes, and an
 * automation that's off stays off.
 */
async function updateAutomation(id, { chatGuid, description, schedule, prompt, condition = null }) {
  const cur = await withDb((db) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
  if (!cur) throw new Error("Automation not found. It may have been deleted.");
  const next = checkAutomation({ chatGuid, schedule, prompt, condition });
  const scheduleChanged = schedule.trim() !== cur.schedule;
  const nextRun = !cur.enabled ? null : scheduleChanged || cur.next_run === null ? next : Number(cur.next_run);
  await withDb(
    (db) =>
      db
        .prepare("UPDATE tasks SET chat_guid = ?, schedule = ?, prompt = ?, description = ?, condition = ?, next_run = ? WHERE id = ?")
        .run(chatGuid, schedule.trim(), prompt.trim(), (description || prompt).trim().slice(0, 120), condition || null, nextRun, id),
    { write: true },
  );
}

async function setAutomationEnabled(id, enabled) {
  const t = await withDb((db) => db.prepare("SELECT schedule FROM tasks WHERE id = ?").get(id));
  if (!t) throw new Error("Automation not found.");
  const next = enabled ? nextRunFor(t.schedule) : null;
  if (enabled && next === null) throw new Error("That one-time automation is already in the past.");
  await withDb((db) => db.prepare("UPDATE tasks SET enabled = ?, next_run = ? WHERE id = ?").run(enabled ? 1 : 0, next, id), { write: true });
}

async function deleteAutomation(id) {
  await withDb((db) => db.prepare("DELETE FROM tasks WHERE id = ?").run(id), { write: true });
}

/** "0 12 * * 2" → "Tuesdays at 12:00 PM". Falls back to the raw expression. */
function describeSchedule(s) {
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return `Once, ${d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
  }
  const f = s.trim().split(/\s+/);
  if (f.length !== 5) return s;
  const [min, hour, dom, mon, dow] = f;
  const time = /^\d+$/.test(min) && /^\d+$/.test(hour)
    ? new Date(2000, 0, 1, Number(hour), Number(min)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;
  const days = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  if (time && dom === "*" && mon === "*") {
    if (dow === "*") return `Every day at ${time}`;
    if (dow === "1-5") return `Weekdays at ${time}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends at ${time}`;
    if (/^[0-6]$/.test(dow)) return `${days[Number(dow)]} at ${time}`;
    if (/^[0-6](,[0-6])+$/.test(dow)) return `${dow.split(",").map((d) => days[Number(d)].slice(0, 3)).join(", ")} at ${time}`;
  }
  if (time && /^\d+$/.test(dom) && mon === "*" && dow === "*") return `Monthly on day ${dom} at ${time}`;
  const every = min.match(/^\*\/(\d+)$/);
  if (every && hour === "*" && dom === "*" && mon === "*") {
    const d = dow === "*" ? "" : dow === "1-5" ? " on weekdays" : dow === "1-3" ? " Mon–Wed" : ` (days ${dow})`;
    return `Every ${every[1]} minutes${d}`;
  }
  return s;
}

// ---------- memory ----------

async function memories() {
  const loc = await locate();
  const conv = await conversations();
  const label = chatLabeler(conv);
  const sessions = await withDb((db) => db.prepare("SELECT chat_guid, session_id FROM chats").all()).catch(() => []);
  const byDir = new Map(sessions.map((s) => [chatDirName(s.chat_guid), s]));
  // Every conversation we know, plus any chat folder on disk.
  const guids = new Set([...conv.direct.map((d) => d.guid).filter(Boolean), ...conv.groups.filter((g) => g.allowed).map((g) => g.guid), ...sessions.map((s) => s.chat_guid)]);
  const out = [];
  const dirs = fs.existsSync(loc.chatsDir) ? fs.readdirSync(loc.chatsDir) : [];
  for (const dir of dirs) {
    if (dir.startsWith("repl_")) continue; // local test chats
    const guid = byDir.get(dir)?.chat_guid ?? [...guids].find((g) => chatDirName(g) === dir) ?? dir.replace(/_/g, ";");
    guids.delete(guid);
    out.push(memoryRow(loc, dir, guid, label, byDir.get(dir)));
  }
  return out.sort((a, b) => b.chars - a.chars || a.label.localeCompare(b.label));
}

function memoryRow(loc, dir, guid, label, session) {
  const file = path.join(loc.chatsDir, dir, "MEMORY.md");
  let text = "";
  let updatedAt = null;
  try {
    text = fs.readFileSync(file, "utf8");
    updatedAt = fs.statSync(file).mtime.toISOString();
  } catch {}
  return { guid, dir, label: label(guid), isGroup: guid.includes(";+;"), text, chars: text.trim().length, updatedAt, hasSession: !!session?.session_id };
}

async function saveMemory(dir, text) {
  const loc = await locate();
  const d = path.join(loc.chatsDir, path.basename(dir));
  if (!fs.existsSync(d)) throw new Error("Unknown conversation.");
  const file = path.join(d, "MEMORY.md");
  if (text.trim()) fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  else fs.rmSync(file, { force: true });
}

/** Like /new in the chat: the next message starts a fresh Claude session. */
async function resetSession(guid) {
  await withDb((db) => db.prepare("UPDATE chats SET session_id = NULL WHERE chat_guid = ?").run(guid), { write: true });
}

// ---------- settings + connections ----------

/** Parts of the weekly roundup that can be switched off (fantasy.roundupAwards.<key>; all default on). */
const ROUNDUP_PARTS = ["highLow", "blowout", "closest", "benchBlunder", "luckyWin", "toughLoss", "topPlayer", "playoffOdds"];

/** Fields the Settings page may change, with validation. Anything else in config.json is left alone. */
const SETTINGS = {
  provider: (v) => {
    if (!["claude", "chatgpt"].includes(v)) throw new Error(`Unknown assistant ${v}`);
    return v;
  },
  agentName: (v) => String(v).trim() || "Claude",
  model: (v) => (v ? String(v) : null),
  "chatgpt.model": (v) => (v ? String(v) : null),
  groupTriggers: (v) => (Array.isArray(v) ? v : String(v).split(",")).map((x) => x.trim()).filter(Boolean),
  respondToAllInGroups: Boolean,
  allowBash: Boolean,
  maxTurns: (v) => Math.max(1, Math.min(200, Math.round(Number(v)) || 40)),
  turnTimeoutMs: (v) => Math.max(30_000, Math.min(3_600_000, Math.round(Number(v)) || 600_000)),
  "voice.enabled": Boolean,
  typingIndicators: Boolean,
  threadedReplies: (v) => {
    if (!["auto", "always", "off"].includes(v)) throw new Error(`Unknown threaded-replies mode ${v}`);
    return v;
  },
  "fantasy.espnLeagueId": (v) => String(v).trim(),
  "fantasy.myTeamId": (v) => (v === "" || v === null ? undefined : Number(v)),
  "fantasy.sleeper": Boolean,
  "fantasy.nflverse": Boolean,
  "fantasy.vegas": Boolean,
  "fantasy.rankings": Boolean,
  "fantasy.tradeValues": Boolean,
  "fantasy.dynasty": Boolean,
  "fantasy.startSitCards": Boolean,
  "fantasy.tradeCards": Boolean,
  "fantasy.compareCards": Boolean,
  ...Object.fromEntries(ROUNDUP_PARTS.map((k) => [`fantasy.roundupAwards.${k}`, Boolean])),
  "fantasy.liveAlerts.enabled": Boolean,
  "fantasy.liveAlerts.thresholdPct": (v) => clampNum(v, 1, 100, 5),
  "fantasy.liveAlerts.checkMinutes": (v) => clampNum(v, 1, 60, 5),
  "fantasy.liveAlerts.minPlayerPoints": (v) => clampNum(v, 0, 50, 1, 1),
  // Dollars a day before the Dashboard warns; blank = off
  "usage.dailyCostAlertUsd": (v) => {
    if (v === null || v === undefined || String(v).trim() === "") return null;
    const n = Number(String(v).trim().replace(/^\$/, ""));
    if (!Number.isFinite(n) || n < 0) throw new Error("The daily cost alert must be a dollar amount of 0 or more, or empty for off.");
    return Math.round(n * 100) / 100;
  },
};

/** A number from the UI, clamped to a sane range and rounded to `decimals`. */
function clampNum(v, min, max, fallback, decimals = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const p = 10 ** decimals;
  return Math.min(max, Math.max(min, Math.round(n * p) / p));
}

/** When the service last downloaded nflverse data (its daily sync writes <dataDir>/nflverse). */
function nflverseStatus(loc, cfg) {
  const season = cfg.fantasy?.season ?? new Date().getFullYear();
  const file = path.join(loc.dataDir, "nflverse", `stats_${season}.csv`);
  try {
    return { updatedAt: fs.statSync(file).mtime.toISOString() };
  } catch {
    return { updatedAt: null };
  }
}

async function settings() {
  const loc = await locate();
  const cfg = await getConfig();
  return {
    provider: providerOf(cfg),
    chatgpt: { model: cfg.chatgpt?.model ?? null, models: chatgptModels(loc), ...chatgptAccount(loc) },
    agentName: cfg.agentName ?? "Claude",
    model: cfg.model ?? null,
    groupTriggers: cfg.groupTriggers ?? [],
    respondToAllInGroups: !!cfg.respondToAllInGroups,
    allowBash: !!cfg.allowBash,
    maxTurns: cfg.maxTurns ?? 40,
    turnTimeoutMs: cfg.turnTimeoutMs ?? 600_000,
    voice: { enabled: !!cfg.voice?.enabled },
    typingIndicators: cfg.typingIndicators !== false,
    threadedReplies: ["auto", "always", "off"].includes(cfg.threadedReplies) ? cfg.threadedReplies : "auto",
    usage: { dailyCostAlertUsd: alertUsd(cfg) },
    connectors: Object.fromEntries(Object.keys(CONNECTORS).map((k) => [k, connectorLevel(cfg, k)])),
    fantasy: cfg.fantasy
      ? {
          espnLeagueId: cfg.fantasy.espnLeagueId ?? "",
          // Whether cookies are saved; the values themselves never go to the renderer
          privateLeague: !!(cfg.fantasy.espnS2 && cfg.fantasy.swid),
          myTeamId: cfg.fantasy.myTeamId ?? null,
          sleeper: cfg.fantasy.sleeper !== false,
          nflverse: cfg.fantasy.nflverse !== false,
          vegas: cfg.fantasy.vegas !== false,
          rankings: cfg.fantasy.rankings !== false,
          tradeValues: cfg.fantasy.tradeValues !== false,
          dynasty: !!cfg.fantasy.dynasty,
          startSitCards: cfg.fantasy.startSitCards !== false,
          tradeCards: cfg.fantasy.tradeCards !== false,
          compareCards: cfg.fantasy.compareCards !== false,
          roundupAwards: Object.fromEntries(ROUNDUP_PARTS.map((k) => [k, cfg.fantasy.roundupAwards?.[k] !== false])),
          nflverseUpdatedAt: nflverseStatus(loc, cfg).updatedAt,
          liveAlerts: liveAlerts(cfg),
        }
      : null,
  };
}

/**
 * Live scoring alerts, with the people who could receive one. Only someone with a fantasy team
 * can be alerted (their matchup is what gets watched), so the candidates are the `fantasy.teams`
 * entries; "everyone" is the "*" subscriber the service understands.
 */
function liveAlerts(cfg) {
  const a = cfg.fantasy?.liveAlerts ?? {};
  const subs = Array.isArray(a.subscribers) ? a.subscribers : [];
  const contacts = cfg.contacts ?? {};
  const teams = cfg.fantasy?.teams ?? {};
  return {
    enabled: !!a.enabled,
    thresholdPct: a.thresholdPct ?? 5,
    checkMinutes: a.checkMinutes ?? 5,
    minPlayerPoints: a.minPlayerPoints ?? 1,
    everyone: subs.includes("*"),
    people: Object.entries(teams).map(([handle, team]) => ({
      handle,
      name: contacts[findKey(contacts, handle)] ?? null,
      team: String(team),
      subscribed: subs.some((x) => x !== "*" && sameHandle(x, handle)),
    })),
  };
}

/**
 * The automation one subscriber needs. It only checks on NFL game days (Sun/Mon/Thu) — the
 * condition itself is silent when nothing is being played, so checking the rest of the week
 * would just be wasted requests. The prompt is never used: a verbatim condition writes the
 * message itself and the agent never runs.
 */
function alertTask(guid, checkMinutes) {
  return {
    chatGuid: guid,
    description: "Live scoring alerts",
    schedule: `*/${checkMinutes} * * * 0,1,4`,
    prompt: "Post the live scoring update for this chat.",
    condition: ALERT_CONDITION,
  };
}

/**
 * Who should have a live-alert automation and who already does. Each subscriber gets one in their
 * own 1:1 chat ("*" means everyone with a fantasy team); someone with no allowed conversation has
 * nowhere to receive it.
 */
async function alertPlan() {
  const cfg = await getConfig();
  if (!cfg.fantasy) return [];
  const a = liveAlerts(cfg);
  const wanted = a.people.filter((p) => a.everyone || p.subscribed);
  if (!wanted.length) return []; // nobody subscribed: no reason to touch the chat index or state.db
  const conv = await conversations();
  const rows = await withDb((db) => db.prepare("SELECT chat_guid FROM tasks WHERE condition = ? AND enabled = 1").all(ALERT_CONDITION));
  const tasked = new Set(rows.map((r) => r.chat_guid));
  return wanted.map((p) => {
    const d = conv.direct.find((x) => sameHandle(x.handle, p.handle));
    return { ...p, guid: d?.guid ?? null, allowed: !!d?.allowed, hasAutomation: !!d?.guid && tasked.has(d.guid) };
  });
}

/** Create the live-alert automations that are missing. Reports per person, and never duplicates. */
async function createAlertAutomations() {
  const cfg = await getConfig();
  if (!cfg.fantasy?.liveAlerts?.enabled) throw new Error("Turn live scoring alerts on first.");
  const minutes = liveAlerts(cfg).checkMinutes;
  const plan = await alertPlan();
  if (!plan.length) throw new Error("Nobody is subscribed to live scoring alerts yet.");
  const created = [];
  const skipped = [];
  for (const p of plan) {
    const who = p.name ?? p.handle;
    if (p.hasAutomation) skipped.push(`${who} already has one`);
    else if (!p.guid || !p.allowed) skipped.push(`${who} has no allowed conversation`);
    else {
      await createAutomation(alertTask(p.guid, minutes));
      created.push(who);
    }
  }
  return { created, skipped };
}

/** Add or remove one person from fantasy.liveAlerts.subscribers ("*" = everyone with a team). */
async function setAlertSubscriber(handle, on) {
  await updateConfig((cfg) => {
    if (!cfg.fantasy) throw new Error("Fantasy football isn't configured.");
    cfg.fantasy.liveAlerts = cfg.fantasy.liveAlerts ?? {};
    const list = Array.isArray(cfg.fantasy.liveAlerts.subscribers) ? cfg.fantasy.liveAlerts.subscribers : [];
    const rest = list.filter((x) => (handle === "*" ? x !== "*" : !sameHandle(x, handle)));
    cfg.fantasy.liveAlerts.subscribers = on ? [...rest, handle] : rest;
  });
  return settings();
}

async function saveSettings(patch) {
  await updateConfig((cfg) => {
    for (const [key, value] of Object.entries(patch)) {
      const clean = SETTINGS[key];
      if (!clean) throw new Error(`Setting ${key} can't be changed here.`);
      const v = clean(value);
      const path = key.split(".");
      const leaf = path.pop();
      if (!path.length) {
        cfg[leaf] = v;
        continue;
      }
      // Fantasy settings only apply once a league exists (espnLeagueId is what creates one).
      if (path[0] === "fantasy" && !cfg.fantasy && leaf !== "espnLeagueId") continue;
      let node = cfg;
      for (const step of path) node = node[step] = node[step] ?? {};
      if (v === undefined) delete node[leaf];
      else node[leaf] = v;
    }
  });
  return settings();
}

async function connections() {
  const cfg = await getConfig();
  const servers = Object.entries(cfg.mcpServers ?? {}).map(([name, s]) => ({
    name,
    type: s.type ?? (s.command ? "stdio" : "http"),
    target: s.url ?? [s.command, ...(s.args ?? [])].filter(Boolean).join(" "),
  }));
  const builtIn = [
    { name: "Scheduler", detail: "Reminders and recurring tasks (every chat)" },
    ...(cfg.fantasy ? [{ name: "Fantasy football", detail: `ESPN league ${cfg.fantasy.espnLeagueId}${cfg.fantasy.sleeper === false ? "" : " + Sleeper"} (every chat)` }] : []),
    ...(cfg.fantasy && cfg.fantasy.nflverse !== false ? [{ name: "NFL usage stats", detail: "nflverse snaps, targets, expected points and injury reports, updated daily" }] : []),
    ...(cfg.fantasy && cfg.fantasy.vegas !== false ? [{ name: "Betting lines", detail: "Spreads, over/unders, implied team points and weather from ESPN (DraftKings)" }] : []),
    ...(cfg.fantasy && cfg.fantasy.rankings !== false ? [{ name: "Expert rankings", detail: "FantasyPros consensus, weekly and rest of season, updated daily" }] : []),
    ...(cfg.fantasy && cfg.fantasy.tradeValues !== false ? [{ name: "Trade values", detail: `FantasyCalc ${cfg.fantasy.dynasty ? "dynasty" : "redraft"} values for this league's format` }] : []),
    providerOf(cfg) === "chatgpt"
      ? { name: "Files, photos & web", detail: "Edit files in the chat folder, view photos, web search (1:1 chats only)" }
      : { name: "Files & web", detail: "Read/write in the chat folder, web search and fetch (1:1 chats only)" },
    ...(cfg.allowBash ? [{ name: "Shell", detail: `Runs commands on this Mac${providerOf(cfg) === "chatgpt" ? " in a sandbox (writes only to the chat folder, no network)" : ""} (1:1 chats only)` }] : []),
  ];
  return { provider: providerOf(cfg), servers, extraTools: cfg.extraAllowedTools ?? [], builtIn };
}

// claude.ai connectors (they come with the Claude sign-in; the agent may only call the tools
// listed in extraAllowedTools, since it never asks for permission).
const CONNECTORS = {
  googleCalendar: {
    prefix: "mcp__claude_ai_Google_Calendar__",
    read: ["list_events", "search_events", "get_event", "list_calendars", "suggest_time"],
    write: ["create_event", "update_event", "delete_event", "respond_to_event"],
  },
};

/** "off" | "read" | "full" from the tools currently allowed. */
function connectorLevel(cfg, key) {
  const c = CONNECTORS[key];
  const tools = cfg.extraAllowedTools ?? [];
  if (tools.includes(c.prefix.replace(/__$/, "")) || c.write.some((t) => tools.includes(c.prefix + t))) return "full";
  return c.read.some((t) => tools.includes(c.prefix + t)) ? "read" : "off";
}

async function setConnector(key, level) {
  const c = CONNECTORS[key];
  if (!c) throw new Error(`Unknown connector ${key}`);
  if (!["off", "read", "full"].includes(level)) throw new Error(`Unknown level ${level}`);
  await updateConfig((cfg) => {
    const server = c.prefix.replace(/__$/, "");
    const rest = (cfg.extraAllowedTools ?? []).filter((t) => t !== server && !t.startsWith(c.prefix));
    const add = level === "off" ? [] : [...c.read, ...(level === "full" ? c.write : [])].map((t) => c.prefix + t);
    cfg.extraAllowedTools = [...rest, ...add];
  });
  return connectorLevel(await getConfig(), key);
}

async function removeExtraTool(name) {
  await updateConfig((cfg) => {
    cfg.extraAllowedTools = (cfg.extraAllowedTools ?? []).filter((t) => t !== name);
  });
}

// ---------- ChatGPT (Codex) ----------

const providerOf = (cfg) => (cfg?.provider === "chatgpt" ? "chatgpt" : "claude");
const PLAN_NAMES = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", team: "Business", business: "Business", edu: "Edu", enterprise: "Enterprise" };
const planName = (p) => PLAN_NAMES[p] ?? p;

/** Waterboy's own Codex home (same as the service's codexHome): its ChatGPT sign-in and settings. */
const codexHome = (loc) => path.join(loc.dataDir, "codex");

/** The signed-in ChatGPT account (plan only; the tokens are never read out). */
function chatgptAccount(loc) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(codexHome(loc), "auth.json"), "utf8"));
    const payload = String(auth.tokens?.id_token ?? "").split(".")[1] ?? "";
    const claims = payload ? JSON.parse(Buffer.from(payload, "base64url").toString()) : {};
    return { signedIn: auth.auth_mode === "chatgpt" && !!auth.tokens, plan: claims["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null };
  } catch {
    return { signedIn: false, plan: null };
  }
}

/** Models Codex lists for this account (its models_cache.json, written after the first turn). */
function chatgptModels(loc) {
  const cache = readJson(path.join(codexHome(loc), "models_cache.json"));
  return (cache?.models ?? []).filter((m) => m.visibility === "list" && m.slug).map((m) => ({ id: m.slug, name: m.display_name || m.slug }));
}

/** The `codex` CLI bundled with the service (node_modules/@openai/codex-darwin-<arch>). */
async function codexBinary() {
  const loc = await locate();
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const triple = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  const bin = path.join(loc.project, "node_modules", `@openai/codex-darwin-${arch}`, "vendor", triple, "bin", "codex");
  if (!fs.existsSync(bin)) throw new Error("This copy of the agent doesn't include ChatGPT support (the codex CLI is missing). Run npm install in the agent project.");
  return { bin, home: codexHome(loc) };
}

function ensureCodexHome(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "config.toml");
  if (!fs.existsSync(file))
    fs.writeFileSync(file, '# Written by Waterboy. Codex settings for each turn are passed on the command line instead.\ncli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n');
}

let signingIn = null;
/**
 * Sign in with ChatGPT: runs `codex login`, which opens the browser and waits for the redirect to
 * localhost:1455. Resolves once it finishes (or after 5 minutes). Only one at a time.
 */
async function chatgptSignIn() {
  if (signingIn) return signingIn;
  const { bin, home } = await codexBinary();
  ensureCodexHome(home);
  signingIn = new Promise((resolve, reject) => {
    const child = spawn(bin, ["login"], { env: { ...process.env, CODEX_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const loc = { dataDir: path.dirname(home) };
      if (code === 0 && chatgptAccount(loc).signedIn) resolve(chatgptAccount(loc));
      else reject(new Error(code === null ? "Sign-in timed out." : `Sign-in didn't finish${/Error|error/.test(out) ? `: ${out.trim().split("\n").pop()}` : "."}`));
    });
  }).finally(() => (signingIn = null));
  return signingIn;
}

async function chatgptSignOut() {
  const { bin, home } = await codexBinary();
  await run(bin, ["logout"], { env: { ...process.env, CODEX_HOME: home } }).catch(() => {});
  fs.rmSync(path.join(home, "auth.json"), { force: true });
  return chatgptAccount({ dataDir: path.dirname(home) });
}

// ---------- first-run setup: ESPN league ----------

const ESPN_SEASONS = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

/** ESPN's SWID cookie is a GUID in braces; people paste it with or without them. */
function cleanSwid(raw) {
  const s = String(raw ?? "").trim().replace(/^\{|\}$/g, "");
  if (!s) return "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))
    throw new Error("SWID should look like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}.");
  return `{${s.toUpperCase()}}`;
}

function cleanLeague({ espnLeagueId, espnS2, swid } = {}) {
  const id = String(espnLeagueId ?? "").trim();
  if (!/^\d{1,12}$/.test(id)) throw new Error("The league ID is the number after leagueId= in your ESPN league's web address.");
  const s2 = String(espnS2 ?? "").trim();
  const sw = cleanSwid(swid);
  if (!!s2 !== !!sw) throw new Error("A private league needs both espn_s2 and SWID. A public league needs neither.");
  return { espnLeagueId: id, espnS2: s2, swid: sw };
}

/**
 * Checks a league the way the agent's league_status tool reads it (same URL, cookies and user
 * agent), so a league that passes here works in chats. Fields left out come from config.json.
 */
async function testLeague(input = {}, { fetchImpl = fetch } = {}) {
  const saved = (await getConfig().catch(() => ({}))).fantasy ?? {};
  const l = cleanLeague({
    espnLeagueId: input.espnLeagueId ?? saved.espnLeagueId,
    espnS2: input.espnS2 ?? saved.espnS2,
    swid: input.swid ?? saved.swid,
  });
  const season = saved.season ?? new Date().getFullYear();
  const views = ["mTeam", "mSettings", "mStatus"].map((v) => `view=${v}`).join("&");
  // ESPN rejects the default "node" user agent with a 403.
  const headers = { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) waterboy/0.1" };
  if (l.espnS2) headers.Cookie = `espn_s2=${l.espnS2}; SWID=${l.swid}`;
  let res;
  try {
    res = await fetchImpl(`${ESPN_SEASONS}/${season}/segments/0/leagues/${l.espnLeagueId}?${views}`, { headers, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`Couldn't reach ESPN: ${e.message}`);
  }
  if (res.status === 401 || res.status === 403)
    throw new Error(
      l.espnS2
        ? "ESPN turned down these cookies. Copy espn_s2 and SWID again from a browser that's signed in to ESPN."
        : "This league is private. Add the espn_s2 and SWID cookies from a browser that's signed in to ESPN.",
    );
  // 400: ESPN rejects ids it can't parse (too long for its integer ids).
  if (res.status === 404 || res.status === 400) throw new Error(`ESPN has no league ${l.espnLeagueId} for the ${season} season.`);
  if (!res.ok) throw new Error(`ESPN answered ${res.status}. Try again in a minute.`);
  const league = await res.json();
  return {
    league: league.settings?.name ?? `League ${l.espnLeagueId}`,
    season: league.seasonId ?? season,
    currentWeek: league.status?.currentMatchupPeriod ?? null,
    teams: (league.teams ?? []).length,
  };
}

/** Saves the league and its cookies (cleared for a public league). Cookies left out stay as saved. */
async function saveLeague(input = {}) {
  const saved = (await getConfig()).fantasy ?? {};
  const l = cleanLeague({ ...input, espnS2: input.espnS2 ?? saved.espnS2, swid: input.swid ?? saved.swid });
  await updateConfig((cfg) => {
    const f = (cfg.fantasy = cfg.fantasy ?? {});
    f.espnLeagueId = l.espnLeagueId;
    if (l.espnS2) Object.assign(f, { espnS2: l.espnS2, swid: l.swid });
    else {
      delete f.espnS2;
      delete f.swid;
    }
  });
  return settings();
}

// ---------- usage (state.db turns) ----------

/** usage.dailyCostAlertUsd as the service reads it: a number of 0 or more, otherwise off (null) */
function alertUsd(cfg) {
  const v = cfg.usage?.dailyCostAlertUsd;
  return typeof v === "number" && v >= 0 ? v : null;
}

/** "2026-10-01" for the local day `ms` falls in (the service's bot/usage.ts localDay) */
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "claude-sonnet-5-5" → "Claude Sonnet 5.5"; anything else as it is */
function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id ?? "");
  return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

const USAGE_DAYS = 30;
const KINDS = ["reply", "scheduled", "alert"];

/**
 * The Dashboard's usage card, from `turns` rows: today / 7-day / 30-day totals, one bucket per local
 * day for the last 30 days, and breakdowns by model, chat (top 5) and kind. Costs are summed from
 * the rows as they are, so the totals match the service's "turn cost" log lines. `unit` says what
 * the card leads with: dollars for Claude, tokens for ChatGPT (it reports no cost).
 */
function usageRollup(rows, { now = Date.now(), label = (id) => id, provider = "claude", thresholdUsd = null } = {}) {
  const today = new Date(now);
  const days = [];
  for (let i = USAGE_DAYS - 1; i >= 0; i--) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i).getTime();
    days.push({ day: localDay(start), start, costUsd: 0, turns: 0, tokens: 0 });
  }
  const byDay = new Map(days.map((d) => [d.day, d]));
  const group = () => new Map();
  const add = (map, key, r, extra) => {
    const g = map.get(key) ?? { key, costUsd: 0, turns: 0, tokens: 0, ...extra };
    g.costUsd += r.cost_usd ?? 0;
    g.turns += 1;
    g.tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
    map.set(key, g);
  };
  const models = group();
  const chats = group();
  const kinds = new Map(KINDS.map((k) => [k, { key: k, costUsd: 0, turns: 0, tokens: 0 }]));
  for (const r of rows) {
    const bucket = byDay.get(localDay(Number(r.at)));
    if (!bucket) continue; // outside the 30 days (or in the future)
    add(byDay, bucket.day, r);
    // Live alerts the service writes itself have no model; they show under "by kind" only
    if (r.model || r.kind !== "alert") add(models, r.model ?? "", r, { name: r.model ? modelName(r.model) : r.provider === "chatgpt" ? "ChatGPT plan default" : "Default model" });
    add(chats, r.chat_id, r, { name: label(r.chat_id) });
    if (kinds.has(r.kind)) add(kinds, r.kind, r);
  }
  const unit = provider === "chatgpt" ? "tokens" : "usd";
  const total = (n) => days.slice(-n).reduce((t, d) => ({ costUsd: t.costUsd + d.costUsd, turns: t.turns + d.turns, tokens: t.tokens + d.tokens }), { costUsd: 0, turns: 0, tokens: 0 });
  const measure = (g) => (unit === "usd" ? g.costUsd : g.tokens);
  const ranked = (map) => [...map.values()].sort((a, b) => measure(b) - measure(a) || b.turns - a.turns);
  const t = total(1);
  return {
    unit,
    today: t,
    week: total(7),
    month: total(USAGE_DAYS),
    days: days.map(({ start, ...d }) => d),
    byModel: ranked(models),
    byChat: ranked(chats).slice(0, 5),
    otherChats: Math.max(0, chats.size - 5),
    byKind: [...kinds.values()],
    // Shown on the Dashboard once per local day (the renderer remembers the day it was dismissed)
    alert: thresholdUsd === null ? null : { thresholdUsd, day: localDay(now), todayCostUsd: t.costUsd, crossed: t.costUsd >= thresholdUsd && t.costUsd > 0 },
  };
}

/** usageRollup for the Dashboard, read from state.db (read-only; the service may be writing) */
async function usage() {
  const loc = await locate();
  const cfg = readJson(loc.configPath) ?? {};
  const t = new Date();
  const since = new Date(t.getFullYear(), t.getMonth(), t.getDate() - (USAGE_DAYS - 1)).getTime();
  let rows;
  try {
    rows = await withDb((db) => {
      // Before the service's first v0.4 start the table doesn't exist yet
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turns'").get()) return null;
      return db.prepare("SELECT at, chat_id, model, provider, cost_usd, input_tokens, output_tokens, kind FROM turns WHERE at >= ?").all(since);
    });
  } catch {
    rows = null; // no state.db yet
  }
  if (!rows) return { available: false, unit: providerOf(cfg) === "chatgpt" ? "tokens" : "usd" };
  const label = chatLabeler(await conversations());
  return { available: true, ...usageRollup(rows, { now: t.getTime(), label, provider: providerOf(cfg), thresholdUsd: alertUsd(cfg) }) };
}

// ---------- overview ----------

async function overview() {
  const [loc, status, ready, cfg, lg] = await Promise.all([locate(), serviceStatus(), readiness(), getConfig().catch(() => ({})), logs()]);
  const configChangedAt = fs.existsSync(loc.configPath) ? fs.statSync(loc.configPath).mtime.toISOString() : null;
  // startedAt comes from `ps` in whole seconds, and the service itself rewrites config.json within
  // a second of starting when it migrates it, so only later changes count.
  const needsRestart = !!(status.running && status.startedAt && configChangedAt && Date.parse(configChangedAt) > Date.parse(status.startedAt) + 5000);
  return {
    agentName: cfg.agentName || "Claude", // the service's default name
    startupError: startupError(loc),
    status,
    readiness: ready,
    needsRestart,
    configChangedAt,
    summary: lg.summary,
    paths: loc,
  };
}

module.exports = {
  /** Every setting the app can change (keys of the saveSettings whitelist) */
  SETTING_KEYS: Object.keys(SETTINGS),
  startupError,
  sendingReadiness,
  automationReadiness,
  serviceChecks,
  sourcesReadiness,
  cleanLeague,
  testLeague,
  saveLeague,
  locate,
  getConfig,
  updateConfig,
  serviceStatus,
  startService,
  pauseService,
  restartService,
  readiness,
  logs,
  conversations,
  setAllowed,
  addPerson,
  cleanHandle,
  setContactName,
  setAdmin,
  setTeam,
  setAccess,
  fantasyTeams,
  automations,
  createAutomation,
  updateAutomation,
  setAutomationEnabled,
  deleteAutomation,
  describeSchedule,
  memories,
  saveMemory,
  resetSession,
  overview,
  usage,
  usageRollup,
  settings,
  saveSettings,
  setAlertSubscriber,
  alertPlan,
  createAlertAutomations,
  alertTask,
  liveAlerts,
  clampNum,
  connections,
  removeExtraTool,
  setConnector,
  chatgptSignIn,
  chatgptSignOut,
  chatgptAccount,
  connectorLevel,
  normalizeHandle,
  chatDirName,
};
