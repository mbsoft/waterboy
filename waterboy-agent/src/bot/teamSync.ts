/**
 * Keeps the league's team names current (see fantasy/teamNames.ts): at startup, every 6 hours,
 * right before the roundup and live alert checks, and when the app asks ("Refresh teams"). Each
 * sync records renames, and migrates any person still mapped to a team *name* in config.json to
 * the team's id (backing config.json up first). What it finds goes into health.json for the app.
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "../config.ts";
import type { FantasyConfig } from "../fantasy/config.ts";
import {
  getTeamNames, RENAME_SHOW_MS, TEAM_NAMES_KEY, mergeTeams, migrateMappings, parseTeamNames, setTeamNames, unmappedPeople,
} from "../fantasy/teamNames.ts";
import type { TeamInfo, TeamNamesState, TeamRename } from "../fantasy/teamNames.ts";

export const SYNC_EVERY_MS = 6 * 3600_000;
/** The app drops this file in the data folder to ask for a sync now. */
export const TEAM_SYNC_REQUEST_FILE = "team-sync-request.json";
const REQUEST_POLL_MS = 3_000;

/** What the app shows: renames of the last week, people whose team can't be found, the last migration. */
export interface TeamSyncStatus {
  syncedAt: number | null;
  error: string | null;
  renames: TeamRename[];
  unmapped: { handle: string; value: string; reason: "name" | "missing" }[];
  migration: { at: number; migrated: number; unmatched: number; backup: string | null } | null;
}

export interface TeamSyncDeps {
  /** The service's live fantasy config: migrated mappings are written into it too. */
  fantasy: FantasyConfig;
  kv: { get(k: string): string | null; set(k: string, v: string): void };
  fetchTeams(): Promise<TeamInfo[]>;
  /** config.json, rewritten (fantasy.teams only) when names are migrated to ids. */
  configFile: string;
  requestFile?: string;
  publish?(status: TeamSyncStatus): void;
  now?(): number;
}

export class TeamSync {
  /** The names the resolvers use (also changed when a roundup announces renames). */
  private get state(): TeamNamesState | null {
    return getTeamNames();
  }
  private running: Promise<void> | null = null;
  private timers: NodeJS.Timeout[] = [];
  status: TeamSyncStatus = { syncedAt: null, error: null, renames: [], unmapped: [], migration: null };

  constructor(private readonly deps: TeamSyncDeps) {
    const saved = parseTeamNames(deps.kv.get(TEAM_NAMES_KEY));
    setTeamNames(saved, (s) => deps.kv.set(TEAM_NAMES_KEY, JSON.stringify(s)));
    this.status.syncedAt = saved?.syncedAt ?? null;
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** Sync now; concurrent calls share one run. Never throws: a failure is logged and shown in the app. */
  sync(reason: string): Promise<void> {
    this.running ??= this.run(reason).finally(() => (this.running = null));
    return this.running;
  }

  /** Sync unless the names are younger than `maxAgeMs` (before a roundup or a live alert window). */
  async freshen(maxAgeMs: number): Promise<void> {
    if (this.state && this.now() - this.state.syncedAt < maxAgeMs) return;
    await this.sync("before a fantasy check");
  }

  private async run(reason: string) {
    const at = this.now();
    try {
      const teams = await this.deps.fetchTeams();
      if (!teams.length) throw new Error("ESPN returned no teams");
      const { state, renames } = mergeTeams(this.state, teams, at);
      this.deps.kv.set(TEAM_NAMES_KEY, JSON.stringify(state));
      setTeamNames(state);
      for (const r of renames) log(`[teams] team ${r.id} renamed: "${r.from}" → "${r.to}"`);
      this.migrate(at);
      this.status = { ...this.status, syncedAt: at, error: null };
      log(`[teams] synced ${teams.length} team names (${reason})${renames.length ? `, ${renames.length} renamed` : ""}`);
    } catch (e) {
      this.status = { ...this.status, error: (e as Error).message };
      log(`[teams] sync failed (${reason}):`, (e as Error).message);
    }
    this.publish(at);
  }

  /** Names in fantasy.teams → ids, in config.json (backed up first) and in the running config. */
  private migrate(at: number) {
    const league = this.state?.teams ?? [];
    const teams = this.deps.fantasy.teams ?? {};
    if (!Object.values(teams).some((v) => typeof v === "string")) return;
    const m = migrateMappings(teams, league);
    if (!m.migrated.length) return;
    let backup: string | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.configFile, "utf8"));
      if (!raw.fantasy || typeof raw.fantasy.teams !== "object") throw new Error("config.json has no fantasy.teams");
      // Only the entries that matched change, and only in fantasy.teams, so edits made since startup survive.
      for (const x of m.migrated) if (String(raw.fantasy.teams[x.handle] ?? "").trim() === x.from) raw.fantasy.teams[x.handle] = x.id;
      const stamp = new Date(at).toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
      backup = `${this.deps.configFile}.bak-teams-${stamp}`;
      fs.copyFileSync(this.deps.configFile, backup);
      const text = `${JSON.stringify(raw, null, 2)}\n`;
      fs.writeFileSync(`${this.deps.configFile}.tmp`, text);
      fs.renameSync(`${this.deps.configFile}.tmp`, this.deps.configFile);
    } catch (e) {
      log("[teams] couldn't save the team ids to config.json:", (e as Error).message);
      return;
    }
    this.deps.fantasy.teams = m.teams;
    for (const x of m.migrated) log(`[teams] ${x.handle}: "${x.from}" → team ${x.id} (${x.name}, ${x.how} match)`);
    if (m.unmatched.length) log(`[teams] ${m.unmatched.length} team name(s) didn't match any team; pick them in the app (Conversations)`);
    this.status = {
      ...this.status,
      migration: { at, migrated: m.migrated.length, unmatched: m.unmatched.length, backup: backup ? path.basename(backup) : null },
    };
  }

  private publish(at: number) {
    const league = this.state?.teams ?? [];
    this.status = {
      ...this.status,
      renames: (this.state?.renames ?? []).filter((r) => at - r.at < RENAME_SHOW_MS),
      // Without a successful sync there is nothing to check against.
      unmapped: league.length ? unmappedPeople(this.deps.fantasy.teams ?? {}, league) : [],
    };
    this.deps.publish?.(this.status);
  }

  /** Sync now and every 6 hours, and whenever the app asks. */
  start() {
    void this.sync("startup");
    this.timers.push(setInterval(() => void this.sync("every 6 hours"), SYNC_EVERY_MS));
    const req = this.deps.requestFile;
    if (req)
      this.timers.push(setInterval(() => {
        if (!fs.existsSync(req)) return;
        fs.rmSync(req, { force: true });
        void this.sync("asked from the app");
      }, REQUEST_POLL_MS));
    for (const t of this.timers) t.unref?.();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
