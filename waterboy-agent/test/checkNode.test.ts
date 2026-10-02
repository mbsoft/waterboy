import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error plain .mjs script, no types
import { nodeProblem, nvmNodeBin } from "../scripts/check-node.mjs";

test("npm scripts stop with a plain message on a Node older than 22.13", () => {
  assert.equal(nodeProblem("22.13.0"), null);
  assert.equal(nodeProblem("24.1.0"), null);
  assert.match(nodeProblem("20.19.4"), /needs Node 22\.13 or newer \(for node:sqlite\), but this is Node 20\.19\.4/);
  assert.match(nodeProblem("22.12.9"), /22\.12\.9/);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-nvm-"));
  assert.equal(nvmNodeBin(home), null, "no nvm");
  for (const v of ["v20.19.4", "v22.13.0", "v22.23.2", "v23.11.1", "v18.0.0"]) fs.mkdirSync(path.join(home, ".nvm/versions/node", v), { recursive: true });
  assert.equal(nvmNodeBin(home), path.join(home, ".nvm/versions/node/v22.23.2/bin"), "the newest 22.x, as in .nvmrc");
  fs.rmSync(path.join(home, ".nvm/versions/node/v22.23.2"), { recursive: true });
  fs.rmSync(path.join(home, ".nvm/versions/node/v22.13.0"), { recursive: true });
  assert.equal(nvmNodeBin(home), path.join(home, ".nvm/versions/node/v23.11.1/bin"), "otherwise the newest that works");

  // On a good Node the script is silent and lets the command run
  const ok = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../scripts/check-node.mjs")], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.equal(ok.stderr, "");
});
