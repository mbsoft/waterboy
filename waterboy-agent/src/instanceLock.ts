/**
 * One live agent per data folder. A second agent sending from the same install (e.g. `npm start` while the
 * launchd service runs) would double every reply and scheduled post, groups included. A live instance
 * takes `agent.lock` (its pid); another live instance then refuses to start. Dry runs don't take or need
 * the lock. A lock whose process is gone (a crash) is taken over.
 */
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

/**
 * Take the lock, or return who holds it. `isAlive` is injectable for tests.
 * Returns { ok: true, release } or { ok: false, holder }.
 */
export function acquireLock(dataDir: string, pid = process.pid, isAlive = alive): { ok: true; release: () => void } | { ok: false; holder: LockInfo } {
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
      if (holder && holder.pid !== pid && isAlive(holder.pid)) return { ok: false, holder };
      fs.rmSync(file, { force: true }); // stale (crashed) or unreadable: take it over
    }
  }
  throw new Error(`Couldn't take ${file}`);
}
