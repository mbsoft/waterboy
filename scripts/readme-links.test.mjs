import { test } from "node:test";
import assert from "node:assert/strict";
import { updateReadme } from "./readme-links.mjs";

const README = `## Install

1. **Download** the latest version:
   <!-- download-links:start -->
   - old link
   <!-- download-links:end -->

2. Next step
`;

test("the download block is replaced with links to the release, and nothing else changes", () => {
  const out = updateReadme(README, "v0.3.0");
  assert.match(out, /\[Download Waterboy 0\.3\.0 for Apple silicon \(M1 and later\)\]\(https:\/\/github\.com\/mbsoft\/waterboy\/releases\/download\/v0\.3\.0\/Waterboy-0\.3\.0-arm64\.dmg\)/);
  assert.match(out, /releases\/download\/v0\.3\.0\/Waterboy-0\.3\.0-x64\.dmg/);
  assert.doesNotMatch(out, /old link/);
  assert.ok(out.startsWith("## Install\n\n1. **Download** the latest version:\n   <!-- download-links:start -->"));
  assert.ok(out.endsWith("<!-- download-links:end -->\n\n2. Next step\n"));
  // Running it again for the same release is a no-op; a newer release replaces it.
  assert.equal(updateReadme(out, "v0.3.0"), out);
  assert.match(updateReadme(out, "v0.3.1"), /Waterboy-0\.3\.1-arm64\.dmg/);
  assert.doesNotMatch(updateReadme(out, "v0.3.1"), /0\.3\.0/);
});

test("a README without the markers is an error", () => {
  assert.throws(() => updateReadme("# no block\n", "v1.0.0"), /no <!-- download-links:start -->/);
});
