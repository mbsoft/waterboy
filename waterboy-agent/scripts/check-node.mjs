/**
 * Runs before the npm scripts: Waterboy needs Node 22.13+ (node:sqlite). `npm run` doesn't enforce
 * "engines", and an older Node fails with a stack trace about node:sqlite, so say it plainly and
 * point at a Node 22 that's already installed when there is one. Plain JS, no imports that need 22.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Why this Node can't run Waterboy, or null when it can */
export function nodeProblem(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) return null;
  return `Waterboy needs Node 22.13 or newer (for node:sqlite), but this is Node ${version}.`;
}

/**
 * An nvm-installed Node that works, e.g. ~/.nvm/versions/node/v22.23.2/bin: the newest 22.x (the
 * version in .nvmrc), otherwise the newest that works.
 */
export function nvmNodeBin(home = os.homedir()) {
  const dir = path.join(home, ".nvm", "versions", "node");
  let versions = [];
  try {
    versions = fs.readdirSync(dir).filter((v) => /^v\d+\.\d+\.\d+$/.test(v) && !nodeProblem(v.slice(1)));
  } catch {
    return null;
  }
  const key = (v) => v.slice(1).split(".").map(Number);
  versions.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return (y[0] === 22) - (x[0] === 22) || y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  return versions.length ? path.join(dir, versions[0], "bin") : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problem = nodeProblem();
  if (problem) {
    const bin = nvmNodeBin();
    console.error(problem);
    console.error(`It's running ${process.execPath}.`);
    if (bin) console.error(`Node from nvm works. Run it with:\n  PATH="${bin}:$PATH" npm run <script>\nor put ${bin} first in your PATH (~/.zshrc).`);
    else console.error("Install Node 22 (https://nodejs.org or nvm install 22) and run the command again.");
    process.exit(1);
  }
}
