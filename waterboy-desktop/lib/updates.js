/**
 * App updates from GitHub Releases (electron-updater; the feed is the `publish` entry in electron-builder.yml).
 *
 * Checks on launch and every few hours and downloads in the background, but only installs when the user
 * clicks "Restart to update": Squirrel swaps the app bundle, the app relaunches, and service.ensure()
 * sees the new version and restarts the service on it. Installing silently on quit would swap the bundle
 * under a running service, which could then start the new Claude/Codex binaries from the old code.
 */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Update states the Dashboard shows: idle, checking, downloading, ready (with version), error. */
function createUpdater({ autoUpdater, log = console }) {
  let status = { state: "idle" };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = log;
  autoUpdater.on("checking-for-update", () => status.state !== "ready" && (status = { state: "checking" }));
  autoUpdater.on("update-not-available", () => (status = { state: "idle", checkedAt: new Date().toISOString() }));
  autoUpdater.on("download-progress", (p) => (status = { state: "downloading", percent: Math.round(p.percent ?? 0) }));
  autoUpdater.on("update-downloaded", (info) => (status = { state: "ready", version: info.version, notes: typeof info.releaseNotes === "string" ? info.releaseNotes : null }));
  // A failed check (offline, GitHub down) isn't worth a banner; the next one tries again.
  autoUpdater.on("error", (e) => {
    log.warn?.(`update check failed: ${e?.message ?? e}`);
    if (status.state !== "ready") status = { state: "error", error: String(e?.message ?? e) };
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  let timer = null;
  return {
    status: () => status,
    start() {
      check();
      timer = setInterval(check, CHECK_EVERY_MS);
      timer.unref?.();
    },
    stop: () => clearInterval(timer),
    install() {
      if (status.state !== "ready") throw new Error("No update has been downloaded yet.");
      autoUpdater.quitAndInstall(false, true); // relaunch afterwards, so the service moves to the new version
    },
  };
}

/** No updater when running from source, when capturing screenshots, or when WATERBOY_NO_UPDATES=1. */
function enabled({ isPackaged, env = process.env }) {
  return isPackaged && !env.CAPTURE_DIR && env.WATERBOY_NO_UPDATES !== "1";
}

module.exports = { createUpdater, enabled, CHECK_EVERY_MS };
