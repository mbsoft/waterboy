#!/usr/bin/env node
/**
 * Rewrites the README's download links from the published releases:
 *   gh api repos/mbsoft/waterboy/releases | node scripts/readme-links.mjs
 * The block between the downloads markers gets the newest stable release's Apple silicon and Intel
 * DMGs, plus a "Latest beta" line while a published prerelease is newer than that. Drafts are ignored.
 * Run by .github/workflows/download-links.yml whenever a release is published.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const README = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../README.md");
const START = "<!-- downloads:start -->";
const END = "<!-- downloads:end -->";
const INDENT = "   ";

/** The DMG download URL for each architecture of a release (GitHub API shape); throws if one is missing. */
export function dmgs(release) {
  const find = (arch) => {
    const asset = release.assets.find((a) => a.name.endsWith(`-${release.tag_name.replace(/^v/, "")}-${arch}.dmg`));
    if (!asset) throw new Error(`${release.tag_name} has no ${arch} DMG.`);
    return asset.browser_download_url;
  };
  return { arm64: find("arm64"), x64: find("x64") };
}

/** The newest published stable release and, if newer than it, the newest published prerelease. */
export function pick(releases) {
  const published = releases.filter((r) => !r.draft && r.published_at).sort((a, b) => b.published_at.localeCompare(a.published_at));
  const stable = published.find((r) => !r.prerelease) ?? null;
  const beta = published.find((r) => r.prerelease) ?? null;
  return { stable, beta: beta && (!stable || beta.published_at > stable.published_at) ? beta : null };
}

/** The README download block for those releases. */
export function block({ stable, beta }, repo = "https://github.com/mbsoft/waterboy") {
  const version = (r) => r.tag_name.replace(/^v/, "");
  const date = (r) => r.published_at.slice(0, 10);
  const lines = [START];
  if (stable) {
    const d = dmgs(stable);
    lines.push(
      `- **[Waterboy ${version(stable)}, Apple silicon (M1 and later)](${d.arm64})**`,
      `- **[Waterboy ${version(stable)}, Intel](${d.x64})**`,
      "",
      `Released ${date(stable)} · [release notes](${stable.html_url}) · [SHA256SUMS.txt](${repo}/releases/download/${stable.tag_name}/SHA256SUMS.txt)`,
    );
  } else {
    lines.push(`- **[Download from GitHub Releases](${repo}/releases)**: \`arm64\` for Apple silicon, \`x64\` for Intel`);
  }
  if (beta) {
    const d = dmgs(beta);
    lines.push("", `Latest beta: **${version(beta)}** (${date(beta)}): [Apple silicon](${d.arm64}) · [Intel](${d.x64}) · [notes](${beta.html_url}). Betas don't update automatically.`);
  }
  lines.push(END);
  return lines.map((l, i) => (i === 0 || l === "" ? l : INDENT + l)).join("\n");
}

/** README text with the download block replaced; throws if the markers are missing. */
export function updateReadme(text, releases) {
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error(`README.md has no ${START} … ${END} block.`);
  return text.slice(0, start) + block(pick(releases)) + text.slice(end + END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const releases = JSON.parse(fs.readFileSync(0, "utf8"));
  const before = fs.readFileSync(README, "utf8");
  const after = updateReadme(before, releases);
  fs.writeFileSync(README, after);
  const { stable, beta } = pick(releases);
  console.log(`${after === before ? "README unchanged" : "README updated"}: stable ${stable?.tag_name ?? "none"}, beta ${beta?.tag_name ?? "none"}`);
}
