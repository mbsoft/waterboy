const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { bundle, plistXml } = require("../lib/service");

function fakeApp(root) {
  const res = path.join(root, "Waterboy.app/Contents/Resources");
  fs.mkdirSync(path.join(res, "agent"), { recursive: true });
  fs.writeFileSync(path.join(res, "agent/run.sh"), "");
  return { resourcesPath: res, execPath: path.join(root, "Waterboy.app/Contents/MacOS/Waterboy"), version: "1.2.3" };
}

test("the bundled service is found, and never installed from a DMG or a translocated copy", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-"));
  const b = bundle(fakeApp(tmp));
  assert.equal(b.agentDir, path.join(tmp, "Waterboy.app/Contents/Resources/agent"));
  assert.equal(b.appPath, path.join(tmp, "Waterboy.app"));
  assert.equal(b.blocked, null);
  assert.equal(bundle({ resourcesPath: path.join(tmp, "nope"), execPath: "/x", version: "1" }), null);

  const dmg = bundle({ ...fakeApp(tmp), execPath: "/Volumes/Waterboy 1.2.3/Waterboy.app/Contents/MacOS/Waterboy" });
  assert.match(dmg.blocked, /Applications folder/);
  const translocated = bundle({ ...fakeApp(tmp), execPath: "/private/var/folders/x/AppTranslocation/ABC/d/Waterboy.app/Contents/MacOS/Waterboy" });
  assert.match(translocated.blocked, /Applications folder/);
});

test("the LaunchAgent runs the bundled launcher with the config in the data folder", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-"));
  const b = bundle(fakeApp(path.join(tmp, "A & B")));
  const file = path.join(tmp, "local.waterboy.plist");
  fs.writeFileSync(file, plistXml(b, { home: "/Users/me" }));
  const p = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]).toString());
  assert.equal(p.Label, "local.waterboy");
  assert.deepEqual(p.ProgramArguments, ["/bin/bash", path.join(b.agentDir, "run.sh")]); // "&" survives XML escaping
  assert.equal(p.WorkingDirectory, b.agentDir);
  assert.deepEqual(p.EnvironmentVariables, {
    WATERBOY_BIN: b.execPath,
    WATERBOY_VERSION: "1.2.3",
    IMESSAGE_AGENT_CONFIG: "/Users/me/.imessage-agent/config.json",
    HOME: "/Users/me",
  });
  assert.equal(p.StandardErrorPath, "/Users/me/.imessage-agent/logs/agent.err.log");
  assert.equal(p.KeepAlive, true);
});
