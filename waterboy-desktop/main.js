const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const agent = require("./lib/agent");
const service = require("./lib/service");
const updates = require("./lib/updates");
const { redactPage, namesToRedact } = require("./lib/redact");
const { TABS: SETTINGS_TABS } = require("./renderer/settingsTabs");

app.setName("Waterboy");

// "Buy me a beer" link: the `funding` URL in package.json (the About page hides the card without one).
const SUPPORT_URL = (() => {
  const f = require("./package.json").funding;
  const url = typeof f === "string" ? f : f?.url;
  return /^https:\/\//.test(url ?? "") ? url : null;
})();

// The packaged app carries the service (Contents/Resources/agent) and installs/updates it on launch.
const BUNDLE = app.isPackaged ? service.bundle({ resourcesPath: process.resourcesPath, execPath: process.execPath, version: app.getVersion() }) : null;
let setup = { state: BUNDLE ? "checking" : "unbundled" };
let ensuring = null; // the launch-time install/update, which the first overview waits for
// App updates from GitHub Releases; null when running from source.
const UPDATER = updates.enabled({ isPackaged: app.isPackaged }) ? updates.createUpdater({ autoUpdater: require("electron-updater").autoUpdater }) : null;

// System Settings → Privacy & Security panes the setup steps link to.
const PRIVACY_PANES = {
  fullDiskAccess: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

// The renderer can call exactly these, nothing else.
const API = {
  overview: async () => {
    await ensuring;
    return { ...(await agent.overview()), setup: { ...setup, bundled: !!BUNDLE }, update: UPDATER?.status() ?? null };
  },
  // Quit, install the downloaded update and relaunch (which moves the service to the new version).
  installUpdate: () => {
    if (!UPDATER) throw new Error("Updates are only available in the installed app.");
    UPDATER.install();
  },
  // Switch to (or install) the service bundled with this app.
  installService: async () => {
    setup = await service.adopt(BUNDLE);
    return setup;
  },
  start: () => agent.startService(),
  pause: () => agent.pauseService(),
  restart: () => agent.restartService(),
  logs: () => agent.logs(),
  conversations: () => agent.conversations(),
  setAllowed: (key, on) => agent.setAllowed(key, on),
  addPerson: (person) => agent.addPerson(person),
  setContactName: (handle, name) => agent.setContactName(handle, name),
  setAdmin: (handle, on) => agent.setAdmin(handle, on),
  setTeam: (handle, team) => agent.setTeam(handle, team),
  setAccess: (handle, level) => agent.setAccess(handle, level),
  fantasyTeams: () => agent.fantasyTeams(),
  setAlertSubscriber: (handle, on) => agent.setAlertSubscriber(handle, on),
  alertPlan: () => agent.alertPlan(),
  setTestGroup: (guid, on) => agent.setTestGroup(guid, on),
  runGroupSimulation: (speed) => agent.runGroupSimulation(speed),
  stopGroupSimulation: () => agent.stopGroupSimulation(),
  createAlertAutomations: () => agent.createAlertAutomations(),
  legacyAlerts: () => agent.legacyAlerts(),
  replaceLegacyAlerts: (ids) => agent.replaceLegacyAlerts(ids),
  automations: () => agent.automations(),
  createAutomation: (t) => agent.createAutomation(t),
  updateAutomation: (id, t) => agent.updateAutomation(id, t),
  setAutomationEnabled: (id, on) => agent.setAutomationEnabled(id, on),
  deleteAutomation: (id) => agent.deleteAutomation(id),
  describeSchedule: (s) => agent.describeSchedule(s),
  memories: () => agent.memories(),
  saveMemory: (dir, text) => agent.saveMemory(dir, text),
  resetSession: (guid) => agent.resetSession(guid),
  usage: () => agent.usage(),
  settings: () => agent.settings(),
  saveSettings: (patch) => agent.saveSettings(patch),
  connections: () => agent.connections(),
  removeExtraTool: (name) => agent.removeExtraTool(name),
  setConnector: (key, level) => agent.setConnector(key, level),
  // ChatGPT sign-in for the ChatGPT assistant (runs the bundled `codex login`, which opens the browser).
  chatgptSignIn: () => agent.chatgptSignIn(),
  chatgptSignOut: () => agent.chatgptSignOut(),
  // First-run setup: the ESPN league (test before saving) and the privacy panes to grant access in.
  testLeague: (league) => agent.testLeague(league),
  saveLeague: (league) => agent.saveLeague(league),
  openPrivacy: async (pane) => {
    const url = PRIVACY_PANES[pane];
    if (!url) throw new Error(`Unknown privacy pane ${pane}`);
    await shell.openExternal(url);
  },
  // Only the agent's own files and folders can be opened.
  open: async (what) => {
    const loc = await agent.locate();
    const target = { config: loc.configPath, logs: path.dirname(loc.logFile), data: loc.dataDir, project: loc.project }[what];
    if (!target) throw new Error(`Unknown location ${what}`);
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  },
  version: () => ({ app: app.getVersion(), electron: process.versions.electron, node: process.versions.node, support: !!SUPPORT_URL }),
  openSupport: async () => {
    if (!SUPPORT_URL) throw new Error("No Buy Me a Coffee link is set.");
    await shell.openExternal(SUPPORT_URL);
  },
};

for (const [name, fn] of Object.entries(API)) {
  ipcMain.handle(`agent:${name}`, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: "Waterboy",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
    show: false,
    // Full-page screenshots can be taller than the screen.
    enableLargerThanScreen: !!process.env.CAPTURE_DIR,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "renderer/index.html"));
  win.once("ready-to-show", () => {
    win.show();
    if (process.env.CAPTURE_DIR) capture(win, process.env.CAPTURE_DIR).finally(() => app.quit());
  });
  // Links open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

/**
 * `npm run capture`: screenshot every page (for checking the UI without clicking through it).
 *   CAPTURE_PAGES=a,b  only these pages      CAPTURE_THEMES=light,dark  one set per theme
 *   CAPTURE_SCROLL=bottom  end of long pages   CAPTURE_FULL=1  whole page, not just the window
 *   CAPTURE_REDACT=1   scramble + blur phone numbers, emails, names and memory (see lib/redact.js)
 *   CAPTURE_CLICK=sel  click an element before capturing
 *   CAPTURE_JS=code    run this in the page before capturing (e.g. press keys); its result is logged
 *   CAPTURE_PAGES=setup-2  a first-run setup step (0-4); settings/fantasy  a Settings tab
 */
async function capture(win, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const redact = process.env.CAPTURE_REDACT === "1";
  const cfg = redact ? await agent.getConfig().catch(() => ({})) : null;
  const opts = redact ? { names: namesToRedact(cfg, [require("node:os").userInfo().username]), homeUser: require("node:os").userInfo().username } : null;
  const [width, height] = win.getContentSize();
  const all = ["dashboard", "connections", "conversations", "memory", "automations", "logs", ...SETTINGS_TABS.map((t) => `settings/${t.id}`), "about"];
  const pages = process.env.CAPTURE_PAGES ? process.env.CAPTURE_PAGES.split(",") : all;
  const themes = process.env.CAPTURE_THEMES ? process.env.CAPTURE_THEMES.split(",") : ["light"];
  for (const theme of themes) {
    nativeTheme.themeSource = theme;
    for (const p of pages) {
      const setupStep = /^setup-(\d)$/.exec(p)?.[1];
      if (setupStep) {
        // Leave #setup first so the next step renders even when the previous capture was a step too.
        await win.webContents.executeJavaScript(`localStorage.setItem("setupStep", "${setupStep}"); location.hash = "#about"`);
        await new Promise((r) => setTimeout(r, 300));
      }
      await win.webContents.executeJavaScript(`location.hash = "#${setupStep ? "setup" : p}"`);
      await new Promise((r) => setTimeout(r, 1800));
      // CAPTURE_SCROLL=bottom shows the end of long pages.
      if (process.env.CAPTURE_SCROLL === "bottom") {
        await win.webContents.executeJavaScript(`document.getElementById("content").scrollTop = 1e6`);
        await new Promise((r) => setTimeout(r, 300));
      }
      // CAPTURE_CLICK=<css selector> clicks the first match first (e.g. to open a form).
      if (process.env.CAPTURE_CLICK) {
        await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(process.env.CAPTURE_CLICK)})?.click()`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (process.env.CAPTURE_JS) {
        console.log(`[capture] ${p}:`, await win.webContents.executeJavaScript(process.env.CAPTURE_JS));
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (process.env.CAPTURE_FULL === "1") {
        const full = await win.webContents.executeJavaScript(`document.querySelector(".page").scrollHeight + 52 + 60`);
        win.setContentSize(width, Math.min(Math.max(height, full), 4000));
        await new Promise((r) => setTimeout(r, 500));
      }
      if (redact) {
        await win.webContents.executeJavaScript(`(${redactPage.toString()})(${JSON.stringify(opts)})`);
        await new Promise((r) => setTimeout(r, 150));
      }
      const img = await win.webContents.capturePage();
      if (process.env.CAPTURE_FULL === "1") win.setContentSize(width, height);
      const name = `${p.replace(/\//g, "-")}${theme === "light" ? "" : `-${theme}`}`;
      fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
      // Which settings the page shows (controls carry data-setting), to check against the tab inventory.
      const keys = await win.webContents.executeJavaScript(`[...document.querySelectorAll("[data-setting]")].map((e) => e.dataset.setting)`);
      if (keys.length) fs.writeFileSync(path.join(dir, `${name}.settings.json`), JSON.stringify(keys, null, 2));
    }
  }
}

app.whenReady().then(() => {
  createWindow();
  if (BUNDLE && !process.env.CAPTURE_DIR)
    ensuring = service.ensure(BUNDLE).then(
      (r) => (setup = r),
      (e) => (setup = { state: "error", error: e.message }),
    );
  UPDATER?.start();
});
app.on("window-all-closed", () => app.quit());
// A live-alerts simulation runs in the service; don't leave one going after the app is closed.
app.on("before-quit", () => {
  try {
    agent.stopGroupSimulationOnQuit();
  } catch {}
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
