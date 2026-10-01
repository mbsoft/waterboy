#!/usr/bin/env node
/**
 * One product version for Waterboy. The desktop app, the service it bundles, and the git tag all carry it.
 *
 *   node scripts/version.mjs check [vX.Y.Z]   the package versions agree (and match the tag, if given)
 *   node scripts/version.mjs bump X.Y.Z       set both packages to X.Y.Z, date the CHANGELOG's Unreleased
 *                                              section, commit "Release vX.Y.Z" and tag vX.Y.Z (push it yourself)
 *   node scripts/version.mjs notes X.Y.Z      print that version's CHANGELOG section (the GitHub Release notes)
 *
 * The Swift helper has no version of its own; it's built from this commit by every release.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["waterboy-desktop", "waterboy-agent"];
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const versions = () => Object.fromEntries(PACKAGES.map((p) => [p, readJson(path.join(ROOT, p, "package.json")).version]));

/** The CHANGELOG section for `version` ("Unreleased" for the pending one), without its heading. */
export function section(text, version) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
  if (end < 0) end = lines.length;
  // Link references at the bottom ("[0.2.0]: https://…") aren't part of the last section.
  const body = lines.slice(start + 1, end).filter((l) => !/^\[[^\]]+\]: /.test(l));
  return body.join("\n").trim();
}

/**
 * Turn "## [Unreleased]" into a dated release heading, with a fresh empty Unreleased above it.
 * A prerelease (X.Y.Z-beta.N) gets a dated copy instead and keeps Unreleased, so the final X.Y.Z
 * release still carries the full notes.
 */
export function dateUnreleased(text, version, date) {
  if (!/^## \[Unreleased\]/m.test(text)) throw new Error("CHANGELOG.md has no ## [Unreleased] section.");
  const notes = section(text, "Unreleased");
  if (!notes) throw new Error("CHANGELOG.md's Unreleased section is empty; write the release notes first.");
  if (text.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md already has ${version}.`);
  if (version.includes("-")) {
    const lines = text.split("\n");
    let next = lines.findIndex((l, i) => i > lines.findIndex((x) => x.startsWith("## [Unreleased]")) && /^## \[/.test(l));
    if (next < 0) next = lines.length;
    lines.splice(next, 0, `## [${version}] - ${date}`, "", notes, "");
    return lines.join("\n");
  }
  return text.replace(/^## \[Unreleased\]/m, `## [Unreleased]\n\n## [${version}] - ${date}`);
}

function check(tag) {
  const v = versions();
  const distinct = [...new Set(Object.values(v))];
  if (distinct.length !== 1) die(`package versions differ: ${JSON.stringify(v)}`);
  const [version] = distinct;
  if (tag && tag.replace(/^v/, "") !== version) die(`tag ${tag} doesn't match the package version ${version}`);
  if (tag && !section(fs.readFileSync(CHANGELOG, "utf8"), version)) die(`CHANGELOG.md has no notes for ${version}`);
  console.log(version);
}

function bump(version) {
  if (!SEMVER.test(version ?? "")) die("usage: version.mjs bump X.Y.Z");
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  if (git("status", "--porcelain")) die("commit or stash your changes first.");
  if (git("tag", "--list", `v${version}`)) die(`tag v${version} already exists.`);
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(CHANGELOG, dateUnreleased(fs.readFileSync(CHANGELOG, "utf8"), version, date));
  for (const p of PACKAGES)
    execFileSync("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], { cwd: path.join(ROOT, p), stdio: "ignore" });
  git("add", "CHANGELOG.md", ...PACKAGES.flatMap((p) => [`${p}/package.json`, `${p}/package-lock.json`]));
  git("commit", "-m", `Release v${version}`);
  git("tag", "-a", `v${version}`, "-m", `Waterboy ${version}`);
  console.log(`Tagged v${version}. Push it to build the release: git push origin HEAD v${version}`);
}

function notes(version) {
  const body = section(fs.readFileSync(CHANGELOG, "utf8"), (version ?? "").replace(/^v/, ""));
  if (!body) die(`CHANGELOG.md has no notes for ${version}`);
  console.log(body);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "check") check(arg);
  else if (cmd === "bump") bump(arg);
  else if (cmd === "notes") notes(arg);
  else die("usage: version.mjs check [vX.Y.Z] | bump X.Y.Z | notes X.Y.Z");
}
