/**
 * Fantasy teams by their stable ESPN id. People are mapped to a team id in `fantasy.teams`; the
 * team's name is looked up when it's used, because owners rename their teams whenever they like.
 *
 * The service keeps the league's id → name (with every name a team has had) in the state db, and
 * refreshes it every few hours (see bot/teamSync.ts). From it come: the current name for an id
 * (group sender labels), old names that still find their team ("how did <old name> do?"), the
 * renames to show on the Dashboard, and the one-time migration of name mappings to ids.
 * Everything here is pure except the in-memory copy the resolvers read (setTeamNames).
 */

export interface TeamInfo {
  id: number;
  name: string;
  abbrev: string;
  owner: string;
}

export interface TeamRecord extends TeamInfo {
  /** Every name this team has had while we watched, oldest first. The last one is `name`. */
  history: { name: string; seenAt: number }[];
}

export interface TeamRename {
  id: number;
  from: string;
  to: string;
  at: number;
}

export interface TeamNamesState {
  syncedAt: number;
  teams: TeamRecord[];
  /** Renames seen in the last RENAME_KEEP_MS, newest last. */
  renames: TeamRename[];
  /** Renames up to this time have been in a posted roundup (each is announced once). */
  announcedAt?: number;
}

/** kv key in the state db. */
export const TEAM_NAMES_KEY = "fantasy:teamNames";
/** Renames are kept this long (the Dashboard shows a week of them). */
export const RENAME_KEEP_MS = 30 * 86_400_000;
export const RENAME_SHOW_MS = 7 * 86_400_000;

/** "  The  Waiver-Wizards! " → "the waiver wizards": what two spellings of one name have in common. */
export function normName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Fold the league's current teams into the saved state: new names are added to each team's
 * history, and a changed name is a rename. The first sync has nothing to compare with, so it
 * reports no renames.
 */
export function mergeTeams(prev: TeamNamesState | null, current: TeamInfo[], at: number): { state: TeamNamesState; renames: TeamRename[] } {
  const before = new Map((prev?.teams ?? []).map((t) => [t.id, t]));
  const renames: TeamRename[] = [];
  const teams = current.map((t): TeamRecord => {
    const was = before.get(t.id);
    const history = [...(was?.history ?? [])];
    if (!history.length || history[history.length - 1].name !== t.name) history.push({ name: t.name, seenAt: at });
    if (was && was.name !== t.name) renames.push({ id: t.id, from: was.name, to: t.name, at });
    return { ...t, history };
  });
  const kept = (prev?.renames ?? []).filter((r) => at - r.at < RENAME_KEEP_MS);
  // The first sync announces nothing older than itself.
  const announcedAt = prev ? (prev.announcedAt ?? 0) : at;
  return { state: { syncedAt: at, teams, renames: [...kept, ...renames], announcedAt }, renames };
}

export function parseTeamNames(raw: string | null): TeamNamesState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as TeamNamesState;
    return Array.isArray(s?.teams)
      ? { syncedAt: Number(s.syncedAt) || 0, teams: s.teams, renames: Array.isArray(s.renames) ? s.renames : [], announcedAt: Number(s.announcedAt) || 0 }
      : null;
  } catch {
    return null;
  }
}

// ---------- matching a name to a team ----------

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** 0..1, 1 = the same once normalized. */
export function similarity(a: string, b: string): number {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/** A fuzzy match has to be at least this close, and clearly closer than the runner-up. */
const FUZZY_MIN = 0.85;
const FUZZY_MARGIN = 0.1;

export type MatchHow = "exact" | "history" | "fuzzy";

/**
 * The team a saved or typed name means: an exact match on a current name (ignoring case, spaces
 * and punctuation), else a name the team used to have, else a close spelling (high bar, and only
 * when one team is clearly closest). Null when none is sure enough.
 */
export function matchTeamName(query: string, teams: TeamRecord[]): { id: number; how: MatchHow } | null {
  const q = normName(query);
  if (!q) return null;
  const exact = teams.filter((t) => normName(t.name) === q);
  if (exact.length === 1) return { id: exact[0].id, how: "exact" };
  const old = teams.filter((t) => t.history.some((h) => normName(h.name) === q));
  if (old.length === 1) return { id: old[0].id, how: "history" };
  if (exact.length || old.length) return null; // two teams share it: not sure
  const scored = teams
    .map((t) => ({ id: t.id, score: Math.max(similarity(query, t.name), ...t.history.map((h) => similarity(query, h.name))) }))
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (best && best.score >= FUZZY_MIN && (!next || best.score - next.score >= FUZZY_MARGIN)) return { id: best.id, how: "fuzzy" };
  return null;
}

// ---------- migrating name mappings to ids ----------

export interface MappingMigration {
  /** The new `fantasy.teams`: matched names became ids; everything else is unchanged. */
  teams: Record<string, string | number>;
  migrated: { handle: string; from: string; id: number; name: string; how: MatchHow | "id" }[];
  /** Names nobody could match. They stay in config as they are. */
  unmatched: { handle: string; value: string }[];
}

/** Replace team names in `fantasy.teams` with ids. Ids written as text ("7") become numbers. */
export function migrateMappings(teams: Record<string, string | number>, league: TeamRecord[]): MappingMigration {
  const out: Record<string, string | number> = {};
  const migrated: MappingMigration["migrated"] = [];
  const unmatched: MappingMigration["unmatched"] = [];
  const byId = new Map(league.map((t) => [t.id, t]));
  for (const [handle, value] of Object.entries(teams)) {
    if (typeof value === "number") {
      out[handle] = value;
      continue;
    }
    const text = String(value).trim();
    if (/^\d+$/.test(text) && byId.has(Number(text))) {
      out[handle] = Number(text);
      migrated.push({ handle, from: text, id: Number(text), name: byId.get(Number(text))!.name, how: "id" });
      continue;
    }
    const m = matchTeamName(text, league);
    if (m) {
      out[handle] = m.id;
      migrated.push({ handle, from: text, id: m.id, name: byId.get(m.id)!.name, how: m.how });
    } else {
      out[handle] = value;
      unmatched.push({ handle, value: text });
    }
  }
  return { teams: out, migrated, unmatched };
}

/** People whose mapping points nowhere: a name that couldn't be migrated, or an id the league no longer has. */
export function unmappedPeople(teams: Record<string, string | number>, league: TeamRecord[]): { handle: string; value: string; reason: "name" | "missing" }[] {
  const ids = new Set(league.map((t) => t.id));
  const out: { handle: string; value: string; reason: "name" | "missing" }[] = [];
  for (const [handle, value] of Object.entries(teams)) {
    if (typeof value === "string") out.push({ handle, value, reason: "name" });
    else if (!ids.has(value)) out.push({ handle, value: String(value), reason: "missing" });
  }
  return out;
}

// ---------- what the resolvers read ----------

let known: TeamNamesState | null = null;
let persist: ((s: TeamNamesState) => void) | undefined;

/** The service sets this at startup and after every sync, with how to save a change (markRenamesAnnounced). */
export function setTeamNames(s: TeamNamesState | null, save?: (s: TeamNamesState) => void) {
  known = s;
  if (save) persist = save;
}

export function getTeamNames(): TeamNamesState | null {
  return known;
}

/**
 * Renames not yet in a posted roundup, one per team (A → B → C reads A → C; a team renamed back
 * to its old name drops out), oldest first.
 */
export function pendingRenames(): TeamRename[] {
  const since = known?.announcedAt ?? 0;
  const byTeam = new Map<number, TeamRename>();
  for (const r of known?.renames ?? []) {
    if (r.at <= since) continue;
    const was = byTeam.get(r.id);
    byTeam.set(r.id, was ? { ...r, from: was.from } : r);
  }
  return [...byTeam.values()].filter((r) => r.from !== r.to);
}

/** A roundup listing renames up to `at` was posted: they won't be listed again. */
export function markRenamesAnnounced(at: number) {
  if (!known || at <= (known.announcedAt ?? 0)) return;
  known = { ...known, announcedAt: at };
  persist?.(known);
}

/** A team's current name by id (or a saved name, as-is), for labels. Undefined when unknown. */
export function teamLabel(team: string | number | undefined | null): string | undefined {
  if (team === undefined || team === null) return undefined;
  if (typeof team === "string") return team;
  return known?.teams.find((t) => t.id === team)?.name;
}

/** The id a name (current or old) belongs to, from the saved names. Exact matches only. */
export function teamIdForName(query: string): number | null {
  if (!known) return null;
  const m = matchTeamName(query, known.teams);
  return m && m.how !== "fuzzy" ? m.id : null;
}

/** Renames in the last `withinMs`, newest last. */
export function recentRenames(withinMs: number, at = Date.now()): TeamRename[] {
  return (known?.renames ?? []).filter((r) => at - r.at < withinMs);
}
