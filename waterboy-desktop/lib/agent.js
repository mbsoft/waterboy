/**
 * Everything the Waterboy desktop app knows about the Waterboy service (../waterboy-agent): where it lives, its
 * launchd job, config.json, state.db (automations, per-chat sessions), logs, per-chat memory,
 * and the recent-chats index the service writes. Runs in Electron's main process only.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
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

  // Claude Code sign-in: a setup-token in the service env file, or Claude Code's own login in
  // the Keychain (checked without reading the secret).
  let claude = { ok: false, detail: "Not signed in" };
  if (/^\s*CLAUDE_CODE_OAUTH_TOKEN=\S+/m.test(env)) claude = { ok: true, detail: "Long-lived token" };
  else if (/^\s*ANTHROPIC_API_KEY=\S+/m.test(env)) claude = { ok: true, detail: "API key (billed to the API)" };
  else {
    const found = await run("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials"])
      .then(() => true)
      .catch(() => false);
    if (found) claude = { ok: true, detail: "Signed in" };
  }

  // Messages access: the service can only write the chat index if it can read chat.db.
  const err = tail(loc.errFile, 4000);
  const idx = readJson(loc.chatIndex);
  let messages;
  if (/Full Disk Access|Cannot read .*chat\.db/i.test(err.split("\n").slice(-6).join("\n")))
    messages = { ok: false, detail: "Needs Full Disk Access" };
  else if (idx) messages = { ok: true, detail: "Ready" };
  else messages = { ok: false, detail: "Waiting for the agent" };

  const n = (cfg.allowedChats ?? []).length;
  return {
    claude,
    messages,
    conversations: { ok: n > 0, detail: n ? `${n} allowed` : "None allowed" },
  };
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

/** Named gates the service checks before a run (waterboy-agent src/conditions.ts). */
const CONDITIONS = ["fantasy_week_final"];

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

/** Fields the Settings page may change, with validation. Anything else in config.json is left alone. */
const SETTINGS = {
  agentName: (v) => String(v).trim() || "Claude",
  model: (v) => (v ? String(v) : null),
  groupTriggers: (v) => (Array.isArray(v) ? v : String(v).split(",")).map((x) => x.trim()).filter(Boolean),
  respondToAllInGroups: Boolean,
  allowBash: Boolean,
  maxTurns: (v) => Math.max(1, Math.min(200, Math.round(Number(v)) || 40)),
  turnTimeoutMs: (v) => Math.max(30_000, Math.min(3_600_000, Math.round(Number(v)) || 600_000)),
  "voice.enabled": Boolean,
  "fantasy.espnLeagueId": (v) => String(v).trim(),
  "fantasy.myTeamId": (v) => (v === "" || v === null ? undefined : Number(v)),
  "fantasy.sleeper": Boolean,
  "fantasy.nflverse": Boolean,
};

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
    agentName: cfg.agentName ?? "Claude",
    model: cfg.model ?? null,
    groupTriggers: cfg.groupTriggers ?? [],
    respondToAllInGroups: !!cfg.respondToAllInGroups,
    allowBash: !!cfg.allowBash,
    maxTurns: cfg.maxTurns ?? 40,
    turnTimeoutMs: cfg.turnTimeoutMs ?? 600_000,
    voice: { enabled: !!cfg.voice?.enabled },
    connectors: Object.fromEntries(Object.keys(CONNECTORS).map((k) => [k, connectorLevel(cfg, k)])),
    fantasy: cfg.fantasy
      ? {
          espnLeagueId: cfg.fantasy.espnLeagueId ?? "",
          myTeamId: cfg.fantasy.myTeamId ?? null,
          sleeper: cfg.fantasy.sleeper !== false,
          nflverse: cfg.fantasy.nflverse !== false,
          nflverseUpdatedAt: nflverseStatus(loc, cfg).updatedAt,
        }
      : null,
  };
}

async function saveSettings(patch) {
  await updateConfig((cfg) => {
    for (const [key, value] of Object.entries(patch)) {
      const clean = SETTINGS[key];
      if (!clean) throw new Error(`Setting ${key} can't be changed here.`);
      const v = clean(value);
      const [a, b] = key.split(".");
      if (!b) cfg[a] = v;
      else {
        if (a === "fantasy" && !cfg.fantasy && b !== "espnLeagueId") continue;
        cfg[a] = cfg[a] ?? {};
        if (v === undefined) delete cfg[a][b];
        else cfg[a][b] = v;
      }
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
    { name: "Files & web", detail: "Read/write in the chat folder, web search and fetch (1:1 chats only)" },
    ...(cfg.allowBash ? [{ name: "Shell", detail: "Runs commands on this Mac (1:1 chats only)" }] : []),
  ];
  return { servers, extraTools: cfg.extraAllowedTools ?? [], builtIn };
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

// ---------- overview ----------

async function overview() {
  const [loc, status, ready, cfg, lg] = await Promise.all([locate(), serviceStatus(), readiness(), getConfig().catch(() => ({})), logs()]);
  const configChangedAt = fs.existsSync(loc.configPath) ? fs.statSync(loc.configPath).mtime.toISOString() : null;
  const needsRestart = !!(status.running && status.startedAt && configChangedAt && Date.parse(configChangedAt) > Date.parse(status.startedAt) + 1000);
  return {
    agentName: cfg.agentName || "Agent",
    status,
    readiness: ready,
    needsRestart,
    configChangedAt,
    summary: lg.summary,
    paths: loc,
  };
}

module.exports = {
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
  settings,
  saveSettings,
  connections,
  removeExtraTool,
  setConnector,
  connectorLevel,
  normalizeHandle,
  chatDirName,
};
