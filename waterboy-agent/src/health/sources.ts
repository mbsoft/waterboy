/**
 * Data-source health (v0.4). The six free fantasy data sources fail independently, and a failure
 * used to show only as "unavailable" in a reply. Every fetch records its outcome here (see
 * `timed`), and HealthReporter publishes the verdicts in health.json for the Dashboard.
 *
 * Kept in memory only, so after a restart every source is "unknown" until it's called again.
 * Recording never throws into the fetch it measures.
 */
import type { FantasyConfig } from "../fantasy/config.ts";
import { now, testHooksOn } from "../testHooks.ts";

export const SOURCE_IDS = ["espn", "sleeper", "nflverse", "lines", "rankings", "tradeValues"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export interface SourceCall {
  source: SourceId;
  ok: boolean;
  /** When the call finished */
  at: number;
  ms: number;
  /** Sanitized (see cleanError) */
  error?: string;
}

export type SourceState = "ok" | "degraded" | "down" | "off" | "unknown";

export interface SourceSnapshot {
  status: SourceState;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  /** Share of the calls in the last 24 h that succeeded (0–1), null without calls */
  okRate24h: number | null;
  /** How many calls okRate24h covers */
  calls24h: number;
  avgMs: number | null;
  /** nflverse only: when the local stats file was last downloaded */
  dataUpdatedAt?: number | null;
}

/** No success for this long (with enough failures) means down rather than degraded */
export const DOWN_AFTER_MS = 6 * 3600_000;
/** Failures in a row before a source can be down; one failure alone is degraded */
export const DOWN_MIN_FAILURES = 2;
/** Below this 24 h success rate a working source is still degraded */
export const MIN_OK_RATE = 0.9;
const DAY_MS = 24 * 3600_000;
/** Per source; far more than a day of calls, so the rate really covers 24 h */
const RING_SIZE = 2000;

interface Entry {
  ok: boolean;
  at: number;
  ms: number;
  /** A failure from an outage that has since ended; left out of the status rate rule */
  outage?: boolean;
}

interface Track {
  ring: Entry[];
  last: Entry | null;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  failuresInRow: number;
}

export class SourceHealth {
  private readonly tracks = new Map<SourceId, Track>();
  /** Set by the service from config.json: disabled sources report "off" */
  enabled: (id: SourceId) => boolean = () => true;
  /** Extra fields per source (nflverse's dataUpdatedAt) */
  extras: Partial<Record<SourceId, () => Partial<SourceSnapshot>>> = {};
  onChange: () => void = () => {};

  constructor(private readonly clock: () => number = now) {}

  record(call: SourceCall) {
    if (!SOURCE_IDS.includes(call.source)) return;
    const t = this.track(call.source);
    const entry: Entry = { ok: call.ok, at: call.at, ms: call.ms };
    if (call.ok) {
      // The outage this success ends no longer counts against the source's rate
      if (t.failuresInRow && this.status(call.source, t) === "down") for (const e of t.ring.slice(-t.failuresInRow)) e.outage = true;
      t.lastOkAt = Math.max(t.lastOkAt ?? 0, call.at);
      t.failuresInRow = 0;
    } else {
      t.lastError = cleanError(call.error ?? "Failed");
      t.lastErrorAt = call.at;
      t.failuresInRow++;
    }
    t.last = entry;
    t.ring.push(entry);
    if (t.ring.length > RING_SIZE) t.ring.splice(0, t.ring.length - RING_SIZE);
    this.onChange();
  }

  snapshot(): Record<SourceId, SourceSnapshot> {
    const out = {} as Record<SourceId, SourceSnapshot>;
    for (const id of SOURCE_IDS) {
      const t = this.track(id);
      const day = this.recent(t);
      const okRate24h = day.length ? day.filter((e) => e.ok).length / day.length : null;
      let extra: Partial<SourceSnapshot> = {};
      try {
        extra = this.extras[id]?.() ?? {};
      } catch {
        // An extra is decoration; never lose the snapshot over it
      }
      out[id] = {
        status: this.status(id, t),
        lastOkAt: t.lastOkAt,
        lastError: t.lastError,
        lastErrorAt: t.lastErrorAt,
        okRate24h: okRate24h === null ? null : Math.round(okRate24h * 1000) / 1000,
        calls24h: day.length,
        avgMs: day.length ? Math.round(day.reduce((s, e) => s + e.ms, 0) / day.length) : null,
        ...extra,
      };
    }
    return out;
  }

  /**
   * ok: the last call succeeded (and 90% of the last day's calls did, outages that have ended
   * aside); degraded: the last call failed but the source isn't down yet, or the rate is low;
   * down: at least 2 failures in a row and no success in 6 h; off: disabled; unknown: never called.
   */
  private status(id: SourceId, t: Track): SourceState {
    if (!this.isEnabled(id)) return "off";
    if (!t.last) return "unknown";
    if (!t.last.ok) {
      const recentOk = t.lastOkAt !== null && this.clock() - t.lastOkAt < DOWN_AFTER_MS;
      return !recentOk && t.failuresInRow >= DOWN_MIN_FAILURES ? "down" : "degraded";
    }
    const counted = this.recent(t).filter((e) => !e.outage);
    if (counted.length && counted.filter((e) => e.ok).length / counted.length < MIN_OK_RATE) return "degraded";
    return "ok";
  }

  private recent(t: Track) {
    const since = this.clock() - DAY_MS;
    return t.ring.filter((e) => e.at > since);
  }

  private isEnabled(id: SourceId) {
    try {
      return this.enabled(id);
    } catch {
      return true;
    }
  }

  private track(id: SourceId): Track {
    let t = this.tracks.get(id);
    if (!t) this.tracks.set(id, (t = { ring: [], last: null, lastOkAt: null, lastError: null, lastErrorAt: null, failuresInRow: 0 }));
    return t;
  }
}

/** Every source needs the fantasy config; the optional ones also have their own switch (default on) */
export function sourceEnabled(fantasy: FantasyConfig | null | undefined, id: SourceId): boolean {
  if (!fantasy) return false;
  const toggle = { espn: undefined, sleeper: fantasy.sleeper, nflverse: fantasy.nflverse, lines: fantasy.vegas, rankings: fantasy.rankings, tradeValues: fantasy.tradeValues }[id];
  return toggle !== false;
}

/** The service's tracker; HealthReporter publishes it */
export const sourceHealth = new SourceHealth();

/**
 * Where fetches report to. In the service that's sourceHealth; the ChatGPT tool server (a child
 * process per turn) relays them to the service through its post file instead.
 */
let sink: (call: SourceCall) => void = (call) => sourceHealth.record(call);
export function setSourceSink(fn: (call: SourceCall) => void) {
  sink = fn;
}

/** Record one fetch. Never throws. */
export function recordSource(source: SourceId, ok: boolean, ms: number, error?: unknown) {
  try {
    sink({ source, ok, at: now(), ms: Math.round(ms), ...(ok ? {} : { error: cleanError(describe(error)) }) });
  } catch {
    // Health is best effort; the fetch result matters more
  }
}

/** Run one fetch (including parsing and validating what came back) and record how it went */
export async function timed<T>(source: SourceId, fetchIt: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    injectFault(source);
    const value = await fetchIt();
    recordSource(source, true, performance.now() - start);
    return value;
  } catch (e) {
    recordSource(source, false, performance.now() - start, e);
    throw e;
  }
}

/** H2 (QA): WATERBOY_FAIL_SOURCES=espn,sleeper fails those sources before the network call */
function injectFault(source: SourceId) {
  if (!testHooksOn) return;
  const failing = (process.env.WATERBOY_FAIL_SOURCES ?? "").split(",").map((s) => s.trim());
  if (failing.includes(source) || failing.includes("all")) throw new Error(`Test fault: ${source} is in WATERBOY_FAIL_SOURCES`);
}

/** "fetch failed" says little; Node keeps the reason (ENOTFOUND, ECONNREFUSED) in `cause` */
function describe(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const msg = String(err?.message ?? e ?? "Failed");
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause && !msg.includes(cause) ? `${msg} (${cause})` : msg;
}

/**
 * health.json is read by the app and can end up in screenshots and bug reports, so errors keep
 * the gist ("ESPN 401 for …/leagues/123") and lose anything secret: query strings, cookies
 * (espn_s2, SWID), keys and tokens, and long opaque strings.
 */
export function cleanError(text: string): string {
  return String(text)
    .split("\n")[0]
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => {
      const bare = url.replace(/[?#].*$/, "");
      const parts = bare.replace(/^https?:\/\//i, "").split("/").filter(Boolean);
      return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : bare;
    })
    .replace(/\b(Bearer|Basic)\s+[^\s;,]+/gi, "$1 [redacted]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[redacted]")
    .replace(/\b(espn_s2|swid|cookie|set-cookie|authorization|api[_-]?key|access[_-]?token|token|key|secret|password)\b\s*[:=]\s*(?!(?:Bearer|Basic) \[)("[^"]*"|[^\s;,&]+)/gi, "$1=[redacted]")
    .replace(/\{?[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}?/gi, "[redacted]")
    .replace(/[A-Za-z0-9%+/=_-]{40,}/g, "[redacted]")
    .trim()
    .slice(0, 300);
}
