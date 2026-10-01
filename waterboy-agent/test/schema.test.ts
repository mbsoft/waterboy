import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { CONFIG_SCHEMA_VERSION, STATE_SCHEMA_VERSION, SchemaTooNewError, migrateConfig } from "../src/schema.ts";
import { loadConfig } from "../src/config.ts";
import { State, migrateState } from "../src/bot/state.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "waterboy-schema-"));

test("config.json without a version is migrated and written back with every other key kept", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ agentName: "Waterboy", dataDir: dir, custom: { keep: true } }));
  const cfg = loadConfig(file);
  assert.equal(cfg.agentName, "Waterboy");
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.equal(Object.keys(written)[0], "schemaVersion");
  assert.deepEqual(written.custom, { keep: true });
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  // Already current: left untouched
  const before = fs.statSync(file).mtimeMs;
  loadConfig(file);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test("a config.json from a newer build is refused with a clear message", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION + 1, dataDir: dir }));
  assert.throws(() => loadConfig(file), (e: unknown) => {
    assert.ok(e instanceof SchemaTooNewError);
    assert.match(e.message, /config\.json is at schema version 2, but this Waterboy build only understands up to 1/);
    return true;
  });
  // ...and not rewritten
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, CONFIG_SCHEMA_VERSION + 1);
  assert.deepEqual(migrateConfig({ schemaVersion: CONFIG_SCHEMA_VERSION }), {
    config: { schemaVersion: CONFIG_SCHEMA_VERSION },
    changed: false,
  });
});

test("a fresh state.db is created at the current version", () => {
  const dir = tmp();
  const state = new State(dir);
  assert.equal((state.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, STATE_SCHEMA_VERSION);
  const id = state.addTask({ chatGuid: "c", schedule: "0 9 * * *", prompt: "p", description: "d", nextRun: 1, condition: "fantasy_week_final" });
  assert.equal(state.tasksForChat("c")[0].id, id);
  assert.equal(state.tasksForChat("c")[0].condition, "fantasy_week_final");
});

test("a state.db from before versioning (no condition column) is migrated with its data", () => {
  const dir = tmp();
  const legacy = new DatabaseSync(path.join(dir, "state.db"));
  legacy.exec(`
    CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE chats (chat_guid TEXT PRIMARY KEY, session_id TEXT, paused INTEGER NOT NULL DEFAULT 0, label TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_guid TEXT NOT NULL, schedule TEXT NOT NULL,
      prompt TEXT NOT NULL, description TEXT NOT NULL, next_run INTEGER, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    INSERT INTO kv (k, v) VALUES ('lastRowId', '42');
    INSERT INTO tasks (chat_guid, schedule, prompt, description, next_run, created_at) VALUES ('c', '0 9 * * 1', 'roundup', 'Weekly', 5, 1);
  `);
  legacy.close();

  const state = new State(dir);
  assert.equal(state.get("lastRowId"), "42");
  assert.deepEqual(
    state.tasksForChat("c").map((t) => [t.prompt, t.condition]),
    [["roundup", null]],
  );
  assert.deepEqual(migrateState(state.db), { from: STATE_SCHEMA_VERSION, to: STATE_SCHEMA_VERSION });
});

test("a state.db from a newer build is refused, not touched", () => {
  const dir = tmp();
  const db = new DatabaseSync(path.join(dir, "state.db"));
  db.exec(`PRAGMA user_version = ${STATE_SCHEMA_VERSION + 1}`);
  db.close();
  assert.throws(() => new State(dir), SchemaTooNewError);
  const check = new DatabaseSync(path.join(dir, "state.db"));
  assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, STATE_SCHEMA_VERSION + 1);
});

test("doctor's read-only load migrates in memory and leaves config.json alone", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  const text = JSON.stringify({ agentName: "Waterboy", dataDir: dir });
  fs.writeFileSync(file, text);
  assert.equal(loadConfig(file, { write: false }).agentName, "Waterboy");
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("the service refuses newer data with a clear message and records why for the Dashboard", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION + 1, dataDir: dir }));
  // Not under launchd (parent isn't pid 1), so it exits instead of waiting
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, IMESSAGE_AGENT_CONFIG: file },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Waterboy can't start: config\.json is at schema version 2/);
  const marker = JSON.parse(fs.readFileSync(path.join(dir, "startup-error.json"), "utf8"));
  assert.equal(marker.kind, "schemaTooNew");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, CONFIG_SCHEMA_VERSION + 1, "file untouched");
});

test("test runs use Sonnet: WATERBOY_MODEL overrides config.json, and the test scripts set it", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, dataDir: dir, model: "claude-opus-5-5" }));
  const prev = process.env.WATERBOY_MODEL;
  try {
    delete process.env.WATERBOY_MODEL;
    assert.equal(loadConfig(file).model, "claude-opus-5-5");
    process.env.WATERBOY_MODEL = "claude-sonnet-5-5";
    assert.equal(loadConfig(file).model, "claude-sonnet-5-5");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).model, "claude-opus-5-5", "config.json untouched");
  } finally {
    if (prev === undefined) delete process.env.WATERBOY_MODEL;
    else process.env.WATERBOY_MODEL = prev;
  }
  const root = path.resolve(import.meta.dirname, "..");
  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const s of ["repl", "start:dry"]) assert.match(scripts[s], /WATERBOY_MODEL=\$\{WATERBOY_MODEL:-claude-sonnet-5-5\}/, s);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8")).model, "claude-sonnet-5-5");
});
