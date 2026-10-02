import { test } from "node:test";
import assert from "node:assert/strict";
import { updatePage } from "./site-links.mjs";

const REPO = "https://github.com/mbsoft/waterboy";
const release = (tag, published_at, extra = {}) => ({
  tag_name: tag,
  prerelease: tag.includes("-"),
  draft: false,
  published_at,
  html_url: `${REPO}/releases/tag/${tag}`,
  assets: ["arm64", "x64"].map((a) => ({ name: `Waterboy-${tag.slice(1)}-${a}.dmg`, browser_download_url: `${REPO}/releases/download/${tag}/Waterboy-${tag.slice(1)}-${a}.dmg` })),
  ...extra,
});
const PAGE = `<header>\n<!-- downloads:start -->\nold\n<!-- downloads:end -->\n</header>\n<section id="install">\n<!-- downloads:start --><!-- downloads:end -->\n</section>`;

test("every download block gets the newest stable release's DMGs; betas and drafts are ignored", () => {
  const out = updatePage(PAGE, [
    release("v0.4.0-beta.1", "2026-10-02T14:00:00Z"),
    release("v0.3.0", "2026-10-01T22:20:00Z"),
    release("v0.5.0", null, { draft: true }),
  ]);
  assert.equal(out.match(/data-download="arm64"/g).length, 2);
  assert.match(out, /href="https:\/\/github\.com\/mbsoft\/waterboy\/releases\/download\/v0\.3\.0\/Waterboy-0\.3\.0-arm64\.dmg" data-download="arm64" data-version="0\.3\.0"/);
  assert.match(out, /Waterboy-0\.3\.0-x64\.dmg/);
  assert.doesNotMatch(out, /beta|0\.5\.0|old/);
  assert.ok(out.startsWith("<header>\n<!-- downloads:start -->\n<a class=\"download\""));
  assert.ok(out.endsWith("<!-- downloads:end -->\n</section>"));
});

test("before any stable release the buttons point at Releases", () => {
  assert.match(updatePage(PAGE, [release("v0.4.0-beta.1", "2026-10-02T14:00:00Z")]), /href="https:\/\/github\.com\/mbsoft\/waterboy\/releases" data-download="releases"/);
});

test("a page without a download block, or with an unclosed one, is an error", () => {
  assert.throws(() => updatePage("<html></html>", []), /no <!-- downloads:start -->/);
  assert.throws(() => updatePage("<!-- downloads:start --> x", []), /no matching/);
});

test("the {{…}} placeholders from the landing-page copy are filled in too", () => {
  const page = `<a href="{{ARM64_URL}}">Apple silicon</a> <a href="{{X64_URL}}">Intel</a> v{{VERSION}} ({{DATE}}) <a href="{{NOTES_URL}}">notes</a> <a href="{{SUMS_URL}}">sums</a>`;
  const out = updatePage(page, [release("v0.3.0", "2026-10-01T22:20:00Z"), release("v0.4.0-beta.1", "2026-10-02T14:00:00Z")]);
  assert.equal(
    out,
    `<a href="${REPO}/releases/download/v0.3.0/Waterboy-0.3.0-arm64.dmg">Apple silicon</a> <a href="${REPO}/releases/download/v0.3.0/Waterboy-0.3.0-x64.dmg">Intel</a> v0.3.0 (2026-10-01) <a href="${REPO}/releases/tag/v0.3.0">notes</a> <a href="${REPO}/releases/download/v0.3.0/SHA256SUMS.txt">sums</a>`,
  );
  assert.match(updatePage(page, []), new RegExp(`href="${REPO}/releases">Apple silicon`));
});
