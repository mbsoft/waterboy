// Renders the Buy Me a Coffee cover image to build/banner.png (3000×1000): `npm run banner`.
// Run with Electron: electron scripts/make-banner.js
// Everything that matters sits in the middle ~2000px, so the page's wide desktop crop and narrow
// mobile crop both keep the mascot and the name.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const mascot = require("./mascot");

// --sidebar: the app's sidebar header instead (renderer/sidebar-banner.png, 600×200 = 3× its
// ~200px width): mascot and name only, since the tagline would be unreadable that small.
const SIDEBAR = process.argv.includes("--sidebar");
const W = SIDEBAR ? 600 : 3000;
const H = SIDEBAR ? 200 : 1000;

// A few loose droplets drifting up behind the mascot: [x, y, size, opacity].
const drops = [
  [640, 250, 60, 0.22], [540, 640, 38, 0.16], [860, 150, 30, 0.2], [2360, 210, 46, 0.18],
  [2520, 700, 64, 0.14], [2240, 820, 30, 0.18], [300, 420, 26, 0.12], [2760, 380, 34, 0.12],
];
const drop = ([x, y, s, o]) =>
  `<svg width="${s}" height="${s * 1.3}" viewBox="0 0 20 26" style="position:absolute;left:${x}px;top:${y}px;opacity:${o}">
    <path d="M10 1 C10 1 2 11 2 16 A8 8 0 0 0 18 16 C18 11 10 1 10 1 Z" fill="#bff0ff"/></svg>`;

// A coffee cup in the same line style as the app's icons.
const cup = `<svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="#0c2f86" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10.5h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3.5c-.6.8-.6 1.7 0 2.5M11.5 3.5c-.6.8-.6 1.7 0 2.5"/></svg>`;

const sidebarHtml = `<!doctype html><html><head><style>
  body { margin:0; width:${W}px; height:${H}px; overflow:hidden; font-family:-apple-system,"SF Pro Display","Helvetica Neue",sans-serif; }
  .field { position:absolute; inset:0; background:linear-gradient(160deg,#3d8bff 0%,#1a5ce0 48%,#0c2f86 100%); }
  .lines { position:absolute; inset:0; background:repeating-linear-gradient(90deg,transparent 0 58px,rgba(255,255,255,.07) 58px 61px); }
  .glow { position:absolute; left:-10px; top:-80px; width:360px; height:360px; border-radius:50%;
    background:radial-gradient(circle,rgba(127,224,255,.4) 0%,rgba(127,224,255,.1) 45%,transparent 70%); }
  .row { position:absolute; inset:0; display:flex; align-items:center; padding-left:4px; }
  h1 { margin:0 0 0 -34px; color:#fff; font-size:84px; line-height:1; font-weight:800; letter-spacing:-3px; text-shadow:0 4px 14px rgba(6,32,92,.35); }
</style></head><body>
  <div class="field"></div><div class="lines"></div><div class="glow"></div>
  <div class="row">${mascot(200, "s", "flex:none")}<h1>Waterboy</h1></div>
</body></html>`;

const html = SIDEBAR ? sidebarHtml : `<!doctype html><html><head><style>
  body { margin:0; width:${W}px; height:${H}px; overflow:hidden; font-family:-apple-system,"SF Pro Display","Helvetica Neue",sans-serif; }
  .field { position:absolute; inset:0; background:linear-gradient(160deg,#3d8bff 0%,#1a5ce0 48%,#0c2f86 100%); }
  /* yard lines, like the icon's field stripes */
  .lines { position:absolute; inset:0; background:repeating-linear-gradient(90deg,transparent 0 244px,rgba(255,255,255,.06) 244px 256px); }
  .glow { position:absolute; left:560px; top:40px; width:1100px; height:1100px; border-radius:50%;
    background:radial-gradient(circle,rgba(127,224,255,.38) 0%,rgba(127,224,255,.10) 42%,transparent 68%); }
  .hash { position:absolute; bottom:0; left:0; right:0; height:120px;
    background:linear-gradient(0deg,rgba(6,32,92,.45),transparent); }
  .row { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:40px; }
  .text { color:#fff; margin-top:-10px; }
  h1 { margin:0; font-size:240px; line-height:1; font-weight:800; letter-spacing:-6px; text-shadow:0 8px 30px rgba(6,32,92,.35); }
  p { margin:26px 0 0 8px; font-size:70px; line-height:1.15; font-weight:500; letter-spacing:-.5px; color:rgba(255,255,255,.92); }
  .pill { display:inline-flex; align-items:center; gap:20px; margin:52px 0 0 4px; padding:22px 44px 22px 34px;
    border-radius:999px; background:#fff; color:#0c2f86; font-size:52px; font-weight:700;
    box-shadow:0 12px 32px rgba(6,32,92,.35); }
</style></head><body>
  <div class="field"></div><div class="lines"></div><div class="glow"></div><div class="hash"></div>
  ${drops.map(drop).join("")}
  <div class="row">
    ${mascot(820, "b", "flex:none;margin-top:-10px")}
    <div class="text">
      <h1>Waterboy</h1>
      <p>Your Fantasy Football assistant,<br>one iMessage away!</p>
      <div class="pill">${cup}Keep the Waterboy hydrated</div>
    </div>
  </div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false, frame: false, enableLargerThanScreen: true, useContentSize: true, webPreferences: { offscreen: true, zoomFactor: 1 } });
  win.setContentSize(W, H);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 600));
  const png = (await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H })).resize({ width: W, height: H, quality: "best" }).toPNG();
  const rel = SIDEBAR ? "renderer/sidebar-banner.png" : "build/banner.png";
  fs.writeFileSync(path.join(__dirname, "..", rel), png);
  console.log(`wrote ${rel} (${W}×${H})`);
  app.quit();
});
