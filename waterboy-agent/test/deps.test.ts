import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The assistant SDKs change behaviour between releases (and bundle their
// CLIs), so they are pinned exactly and only bumped in a reviewed change.
const PINNED = ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"];

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

test("assistant SDKs are pinned to an exact version that matches the lockfile", () => {
  for (const name of PINNED) {
    const wanted = pkg.dependencies?.[name];
    assert.ok(wanted, `${name} is a dependency`);
    assert.match(wanted, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly, not "${wanted}"`);
    assert.equal(lock.packages[`node_modules/${name}`]?.version, wanted, `${name} lockfile matches package.json`);
  }
});
