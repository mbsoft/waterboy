#!/usr/bin/env node
/**
 * Rewrites the README's download links for a published release: `node scripts/readme-links.mjs vX.Y.Z`.
 * Replaces everything between the download-links markers in README.md with links to that release's
 * signed DMGs. Run by .github/workflows/download-links.yml when a release is published.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const README = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../README.md");
const REPO = "https://github.com/mbsoft/waterboy";
const START = "<!-- download-links:start -->";
const END = "<!-- download-links:end -->";

/** The README download block for a release tag. */
export function block(tag) {
  const version = tag.replace(/^v/, "");
  const dmg = (arch) => `${REPO}/releases/download/${tag}/Waterboy-${version}-${arch}.dmg`;
  return [
    START,
    `   - **[Download Waterboy ${version} for Apple silicon (M1 and later)](${dmg("arm64")})**`,
    `   - **[Download Waterboy ${version} for Intel](${dmg("x64")})**`,
    "",
    `   Checksums: [SHA256SUMS.txt](${REPO}/releases/download/${tag}/SHA256SUMS.txt) · [release notes](${REPO}/releases/tag/${tag})`,
    `   ${END}`,
  ].join("\n");
}

/** README text with the download block replaced; throws if the markers are missing. */
export function updateReadme(text, tag) {
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error(`README.md has no ${START} … ${END} block.`);
  return text.slice(0, start) + block(tag) + text.slice(end + END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag ?? "")) {
    console.error("usage: readme-links.mjs vX.Y.Z");
    process.exit(1);
  }
  const before = fs.readFileSync(README, "utf8");
  const after = updateReadme(before, tag);
  fs.writeFileSync(README, after);
  console.log(after === before ? `README already links to ${tag}` : `README now links to ${tag}`);
}
