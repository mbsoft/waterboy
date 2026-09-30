const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdater, enabled } = require("../lib/updates");

function fakeAutoUpdater() {
  const u = new EventEmitter();
  u.checks = 0;
  u.installed = null;
  u.checkForUpdates = async () => void u.checks++;
  u.quitAndInstall = (...args) => (u.installed = args);
  return u;
}
const quiet = { warn() {}, info() {} };

test("downloads in the background but only installs when asked, relaunching the app", () => {
  const au = fakeAutoUpdater();
  const up = createUpdater({ autoUpdater: au, log: quiet });
  assert.equal(au.autoDownload, true);
  assert.equal(au.autoInstallOnAppQuit, false); // never swap the bundle under a running service
  up.start();
  up.stop();
  assert.equal(au.checks, 1);
  assert.throws(() => up.install(), /No update/);

  au.emit("checking-for-update");
  assert.equal(up.status().state, "checking");
  au.emit("download-progress", { percent: 41.6 });
  assert.deepEqual(up.status(), { state: "downloading", percent: 42 });
  au.emit("update-downloaded", { version: "0.3.0", releaseNotes: "notes" });
  assert.deepEqual(up.status(), { state: "ready", version: "0.3.0", notes: "notes" });

  // Later checks and failures don't hide a downloaded update.
  au.emit("checking-for-update");
  au.emit("error", new Error("offline"));
  assert.equal(up.status().state, "ready");

  up.install();
  assert.deepEqual(au.installed, [false, true]);
});

test("a failed check is reported, and the next check clears it", () => {
  const au = fakeAutoUpdater();
  const up = createUpdater({ autoUpdater: au, log: quiet });
  au.emit("error", new Error("GitHub 503"));
  assert.deepEqual(up.status(), { state: "error", error: "GitHub 503" });
  au.emit("update-not-available");
  assert.equal(up.status().state, "idle");
});

test("only the installed app updates itself", () => {
  assert.equal(enabled({ isPackaged: true, env: {} }), true);
  assert.equal(enabled({ isPackaged: false, env: {} }), false);
  assert.equal(enabled({ isPackaged: true, env: { CAPTURE_DIR: "x" } }), false);
  assert.equal(enabled({ isPackaged: true, env: { WATERBOY_NO_UPDATES: "1" } }), false);
});
