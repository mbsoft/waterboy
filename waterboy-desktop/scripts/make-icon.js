// Renders build/icon.icns from the HTML below: `npm run icon` (needs macOS sips + iconutil).
// Run with Electron: electron scripts/make-icon.js
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const mascot = require("./mascot");

// macOS icon grid: 824px rounded square centred on a 1024px canvas, with a soft shadow.
// Waterboy: a sports squeeze bottle (water inside, droplet at the spout) on a royal-blue tile.
const html = `<!doctype html><html><body style="margin:0;width:1024px;height:1024px;background:transparent;display:grid;place-items:center">
<div style="width:824px;height:824px;border-radius:185px;position:relative;overflow:hidden;
  background:linear-gradient(155deg,#3d8bff 0%,#1a5ce0 50%,#0c2f86 100%);
  box-shadow:0 18px 40px rgba(0,0,0,.28), inset 0 2px 0 rgba(255,255,255,.28);display:grid;place-items:center">
  <!-- faint field stripes -->
  <div style="position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 118px,rgba(255,255,255,.06) 118px 124px)"></div>
  ${mascot(700, "m", "position:relative")}
</div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 500));
  const png = (await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })).resize({ width: 1024, height: 1024 }).toPNG();
  const out = path.join(__dirname, "../build");
  const set = path.join(out, "icon.iconset");
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set, { recursive: true });
  fs.writeFileSync(path.join(out, "icon.png"), png);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      execFileSync("/usr/bin/sips", ["-z", String(px), String(px), path.join(out, "icon.png"), "--out", path.join(set, name)], { stdio: "ignore" });
    }
  }
  execFileSync("/usr/bin/iconutil", ["-c", "icns", set, "-o", path.join(out, "icon.icns")]);
  fs.rmSync(set, { recursive: true, force: true });
  console.log("wrote build/icon.icns");
  app.quit();
});
