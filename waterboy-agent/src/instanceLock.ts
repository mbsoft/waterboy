/**
 * One live agent per data folder. A second agent sending from the same install (e.g. `npm start` while the
 * launchd service runs) would double every reply and scheduled post, groups included. A live instance
 * takes `agent.lock` (its pid); another live instance then refuses to start. Dry runs don't take or need
 * the lock. A lock whose process is gone (a crash) is taken over, and so is one whose pid now belongs to a
 * different process (pids are reused after a crash or a reboot): the lock was written before the last boot,
 * or the process with that pid started after the lock was written.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const LOCK_FILE = "agent.lock";

export interface LockInfo {
  pid: number;
  startedAt: number;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
};

/** When the machine booted (ms), from `sysctl kern.boottime`; null if unknown. */
export function bootTimeMs(): number | null {
  try {
    const m = /sec = (\d+)/.exec(execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 2000 }));
    return m ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  }
}

/** When a process started (ms, second precision), from `ps -o lstart=`; null if unknown. */
export function processStartMs(pid: number): number | null {
  try {
    const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C" } }).trim();
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export interface LockProbe {
  isAlive: (pid: number) => boolean;
  bootTime: () => number | null;
  startTime: (pid: number) => number | null;
}
const system: LockProbe = { isAlive: alive, bootTime: bootTimeMs, startTime: processStartMs };

/** Is the holder still the agent that wrote the lock (not a reused pid)? */
export function holderIsLive(holder: LockInfo, probe: LockProbe = system): boolean {
  if (!probe.isAlive(holder.pid)) return false;
  const boot = probe.bootTime();
  if (boot !== null && holder.startedAt < boot) return false; // written before this boot: that process is gone
  const started = probe.startTime(holder.pid);
  if (started !== null && started > holder.startedAt + 2000) return false; // the pid was reused after the lock was written
  return true;
}

/**
 * Take the lock, or return who holds it. `probe` (or a plain isAlive function) is injectable for tests.
 * Returns { ok: true, release } or { ok: false, holder }.
 */
export function acquireLock(dataDir: string, pid = process.pid, probe: LockProbe | ((pid: number) => boolean) = system): { ok: true; release: () => void } | { ok: false; holder: LockInfo } {
  const p: LockProbe = typeof probe === "function" ? { isAlive: probe, bootTime: () => null, startTime: () => null } : probe;
  const file = path.join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, startedAt: Date.now() } satisfies LockInfo), { flag: "wx" });
      const release = () => {
        try {
          const cur = JSON.parse(fs.readFileSync(file, "utf8")) as LockInfo;
          if (cur.pid === pid) fs.unlinkSync(file);
        } catch {}
      };
      return { ok: true, release };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder: LockInfo | null = null;
      try {
        holder = JSON.parse(fs.readFileSync(file, "utf8")) as LockInfo;
      } catch {}
      if (holder && holder.pid !== pid && holderIsLive(holder, p)) return { ok: false, holder };
      fs.rmSync(file, { force: true }); // stale (crashed, rebooted, pid reused) or unreadable: take it over
    }
  }
  throw new Error(`Couldn't take ${file}`);
}
