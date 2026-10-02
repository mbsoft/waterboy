#!/usr/bin/env node
/**
 * Writes the landing page's download buttons from the published releases, at deploy time:
 *   gh api repos/mbsoft/waterboy/releases | node scripts/site-links.mjs _site/index.html
 * Replaces everything between <!-- downloads:start --> and <!-- downloads:end --> in that file with
 * buttons for the newest stable release's Apple silicon and Intel DMGs (same choice as the README,
 * scripts/readme-links.mjs), or a link to Releases before there is one. Drafts and betas are ignored.
 * site/assets/js/downloads.js refreshes the same buttons from the GitHub API in case a deploy is behind.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dmgs, pick } from "./readme-links.mjs";

const START = "<!-- downloads:start -->";
const END = "<!-- downloads:end -->";
const REPO = "https://github.com/mbsoft/waterboy";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The download buttons for a release (GitHub API shape), or a Releases link when there is none. */
export function buttons(stable) {
  if (!stable) {
    return `<a class="download" href="${REPO}/releases" data-download="releases">Download from GitHub Releases</a>`;
  }
  const version = stable.tag_name.replace(/^v/, "");
  const d = dmgs(stable);
  return [
    `<a class="download" href="${esc(d.arm64)}" data-download="arm64" data-version="${esc(version)}">Download for Apple silicon</a>`,
    `<a class="download secondary" href="${esc(d.x64)}" data-download="x64" data-version="${esc(version)}">Download for Intel</a>`,
    `<p class="download-meta">Version <span data-download="version">${esc(version)}</span> · <a href="${esc(stable.html_url)}" data-download="notes">Release notes</a> · <a href="${REPO}/releases/download/${esc(stable.tag_name)}/SHA256SUMS.txt" data-download="sums">Checksums</a></p>`,
  ].join("\n");
}

/** The page with every download block filled in; throws if it has none. */
export function updatePage(html, releases) {
  const { stable } = pick(releases);
  const parts = html.split(START);
  if (parts.length < 2) throw new Error(`The page has no ${START} … ${END} block.`);
  return parts
    .map((part, i) => {
      if (i === 0) return part;
      const end = part.indexOf(END);
      if (end < 0) throw new Error(`A ${START} has no matching ${END}.`);
      return `${START}\n${buttons(stable)}\n${part.slice(end)}`;
    })
    .join("");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: gh api repos/OWNER/REPO/releases | site-links.mjs <page.html>");
    process.exit(1);
  }
  const releases = JSON.parse(fs.readFileSync(0, "utf8"));
  fs.writeFileSync(file, updatePage(fs.readFileSync(file, "utf8"), releases));
  console.log(`${file}: download links for ${pick(releases).stable?.tag_name ?? "Releases (no stable release yet)"}`);
}
