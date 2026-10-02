#!/usr/bin/env node
/**
 * Points the landing page's download links at the newest stable release, at deploy time:
 *   gh api repos/mbsoft/waterboy/releases | node scripts/site-links.mjs _site/index.html
 * Every <a data-download="arm64|x64" href="…"> gets that release's DMG URL, and the text of
 * <… data-release-version>…</…> becomes "Version X.Y.Z". The release is chosen like the README's
 * (scripts/readme-links.mjs): drafts and betas are ignored. Before there is a stable release the page
 * is left as it is (its links point at /releases/latest). site/assets/js/site.js does the same in the
 * browser if a link still has the generic URL. See site/README.md.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dmgs, pick } from "./readme-links.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page with its download links and version text pointing at the newest stable release. */
export function updatePage(html, releases) {
  if (!/<a\b[^>]*\bdata-download="(arm64|x64)"/.test(html)) throw new Error('The page has no <a data-download="arm64|x64"> links.');
  const { stable } = pick(releases);
  if (!stable) return html;
  const d = dmgs(stable);
  const version = stable.tag_name.replace(/^v/, "");
  return html
    .replace(/<a\b[^>]*\bdata-download="(arm64|x64)"[^>]*>/g, (tag, arch) =>
      /\bhref="[^"]*"/.test(tag) ? tag.replace(/\bhref="[^"]*"/, `href="${esc(d[arch])}"`) : tag.replace(/>$/, ` href="${esc(d[arch])}">`),
    )
    .replace(/(<(\w+)\b[^>]*\bdata-release-version\b[^>]*>)[^<]*(<\/\2>)/g, (_, open, _tag, close) => `${open}Version ${esc(version)}${close}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: gh api repos/OWNER/REPO/releases | site-links.mjs <page.html>");
    process.exit(1);
  }
  const releases = JSON.parse(fs.readFileSync(0, "utf8"));
  fs.writeFileSync(file, updatePage(fs.readFileSync(file, "utf8"), releases));
  console.log(`${file}: download links for ${pick(releases).stable?.tag_name ?? "/releases/latest (no stable release yet)"}`);
}
