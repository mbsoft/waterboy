import { test } from "node:test";
import assert from "node:assert/strict";
import { updateReadme, pick } from "./readme-links.mjs";

const README = `1. **Download** the latest version:
   <!-- downloads:start -->
   - old link
   <!-- downloads:end -->

2. Next step
`;
const REPO = "https://github.com/mbsoft/waterboy";
const release = (tag, published_at, { prerelease = tag.includes("-"), draft = false, arches = ["arm64", "x64"] } = {}) => ({
  tag_name: tag,
  prerelease,
  draft,
  published_at: draft ? null : published_at,
  html_url: `${REPO}/releases/tag/${tag}`,
  assets: [
    ...arches.map((a) => ({ name: `Waterboy-${tag.slice(1)}-${a}.dmg`, browser_download_url: `${REPO}/releases/download/${tag}/Waterboy-${tag.slice(1)}-${a}.dmg` })),
    { name: "Waterboy-arm64.dmg", browser_download_url: `${REPO}/releases/download/${tag}/Waterboy-arm64.dmg` },
    { name: "SHA256SUMS.txt", browser_download_url: `${REPO}/releases/download/${tag}/SHA256SUMS.txt` },
  ],
});

test("the newest stable release gets the links; a newer beta gets its own line; drafts never count", () => {
  const releases = [
    release("v0.3.0", "2026-10-08T15:00:00Z"),
    release("v0.3.1-beta.1", "2026-10-10T15:00:00Z"),
    release("v0.2.9", "2026-09-01T15:00:00Z"),
    release("v0.4.0", null, { draft: true }),
  ];
  const out = updateReadme(README, releases);
  assert.match(out, /\[Waterboy 0\.3\.0, Apple silicon \(M1 and later\)\]\(https:\/\/github\.com\/mbsoft\/waterboy\/releases\/download\/v0\.3\.0\/Waterboy-0\.3\.0-arm64\.dmg\)/);
  assert.match(out, /\[Waterboy 0\.3\.0, Intel\]\(.*Waterboy-0\.3\.0-x64\.dmg\)/);
  assert.match(out, /Released 2026-10-08 · \[release notes\]/);
  assert.match(out, /Latest beta: \*\*0\.3\.1-beta\.1\*\* \(2026-10-10\): \[Apple silicon\]\(.*Waterboy-0\.3\.1-beta\.1-arm64\.dmg\)/);
  assert.doesNotMatch(out, /old link|0\.4\.0|0\.2\.9/);
  assert.ok(out.endsWith("   <!-- downloads:end -->\n\n2. Next step\n"));
  assert.equal(updateReadme(out, releases), out); // re-running changes nothing
  // A newer stable release drops the beta line.
  const later = updateReadme(out, [...releases, release("v0.3.1", "2026-10-15T15:00:00Z")]);
  assert.match(later, /Waterboy 0\.3\.1, Intel/);
  assert.doesNotMatch(later, /Latest beta/);
});

test("before any stable release, the block links to Releases and shows the beta", () => {
  const out = updateReadme(README, [release("v0.3.0-beta.3", "2026-10-01T15:00:00Z")]);
  assert.match(out, /Download from GitHub Releases/);
  assert.match(out, /Latest beta: \*\*0\.3\.0-beta\.3\*\*/);
  assert.equal(pick([]).stable, null);
});

test("a release missing an architecture's DMG, or a README without the markers, is an error", () => {
  assert.throws(() => updateReadme(README, [release("v0.3.0", "2026-10-08T15:00:00Z", { arches: ["arm64"] })]), /v0\.3\.0 has no x64 DMG/);
  assert.throws(() => updateReadme("# no block\n", []), /no <!-- downloads:start -->/);
});
