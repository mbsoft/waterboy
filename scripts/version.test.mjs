import { test } from "node:test";
import assert from "node:assert/strict";
import { section, dateUnreleased } from "./version.mjs";

const LOG = `# Changelog

## [Unreleased]

### Added
- Auto-update

## [0.2.0] - 2026-09-26

### Added
- Cards

[Unreleased]: https://example.com/compare
[0.2.0]: https://example.com/0.2.0
`;

test("a version's notes are its CHANGELOG section, without link references", () => {
  assert.equal(section(LOG, "Unreleased"), "### Added\n- Auto-update");
  assert.equal(section(LOG, "0.2.0"), "### Added\n- Cards");
  assert.equal(section(LOG, "9.9.9"), null);
});

test("releasing dates the Unreleased section and opens a new one", () => {
  const out = dateUnreleased(LOG, "0.3.0", "2026-10-01");
  assert.equal(section(out, "Unreleased"), "");
  assert.equal(section(out, "0.3.0"), "### Added\n- Auto-update");
  assert.throws(() => dateUnreleased(out, "0.4.0", "2026-10-02"), /empty/);
  assert.throws(() => dateUnreleased(LOG, "0.2.0", "2026-10-02"), /already has/);
});

test("a prerelease copies the Unreleased notes, so the final release still has them", () => {
  const beta = dateUnreleased(LOG, "0.3.0-beta.1", "2026-10-01");
  assert.equal(section(beta, "Unreleased"), "### Added\n- Auto-update");
  assert.equal(section(beta, "0.3.0-beta.1"), "### Added\n- Auto-update");
  assert.equal(section(beta, "0.2.0"), "### Added\n- Cards");
  const final = dateUnreleased(beta, "0.3.0", "2026-10-08");
  assert.equal(section(final, "0.3.0"), "### Added\n- Auto-update");
  assert.equal(section(final, "Unreleased"), "");
  assert.ok(final.indexOf("## [0.3.0]") < final.indexOf("## [0.3.0-beta.1]"));
});
