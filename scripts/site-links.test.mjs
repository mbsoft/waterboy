import { test } from "node:test";
import assert from "node:assert/strict";
import { updatePage } from "./site-links.mjs";

const REPO = "https://github.com/mbsoft/waterboy";
const LATEST = `${REPO}/releases/latest`;
const release = (tag, published_at, extra = {}) => ({
  tag_name: tag,
  prerelease: tag.includes("-"),
  draft: false,
  published_at,
  html_url: `${REPO}/releases/tag/${tag}`,
  assets: ["arm64", "x64"].map((a) => ({ name: `Waterboy-${tag.slice(1)}-${a}.dmg`, browser_download_url: `${REPO}/releases/download/${tag}/Waterboy-${tag.slice(1)}-${a}.dmg` })),
  ...extra,
});
// The shapes site/index.html uses: attribute order varies, links in buttons and inline.
const PAGE = `<a class="btn btn-primary" data-download="arm64" href="${LATEST}">
  <span>Download for Apple silicon</span></a>
<a class="btn" data-download="x64" href="${LATEST}">Download for Intel</a>
<span data-release-version>Latest release on GitHub</span>
<p>Pick <a href="${LATEST}" data-download="arm64">Apple silicon</a> or <a data-download="x64" href="${LATEST}">Intel</a>.</p>
<a href="${LATEST}">All releases</a>`;

test("download links and the version text point at the newest stable release; betas and drafts are ignored", () => {
  const out = updatePage(PAGE, [release("v0.4.0-beta.1", "2026-10-02T14:00:00Z"), release("v0.3.0", "2026-10-01T22:20:00Z"), release("v0.5.0", null, { draft: true })]);
  assert.equal(out.split(`${REPO}/releases/download/v0.3.0/Waterboy-0.3.0-arm64.dmg`).length - 1, 2);
  assert.equal(out.split(`${REPO}/releases/download/v0.3.0/Waterboy-0.3.0-x64.dmg`).length - 1, 2);
  assert.match(out, /<span data-release-version>Version 0\.3\.0<\/span>/);
  assert.match(out, new RegExp(`<a href="${LATEST}">All releases</a>`)); // links without data-download are left alone
  assert.doesNotMatch(out, /beta|0\.5\.0/);
  assert.equal(updatePage(out, [release("v0.3.0", "2026-10-01T22:20:00Z")]), out); // idempotent
});

test("before any stable release the page is left as it is", () => {
  assert.equal(updatePage(PAGE, [release("v0.4.0-beta.1", "2026-10-02T14:00:00Z")]), PAGE);
});

test("a page without download links is an error", () => {
  assert.throws(() => updatePage("<html></html>", []), /no <a data-download/);
});
