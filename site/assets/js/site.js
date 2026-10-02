// Download buttons: the deploy writes the newest release's DMG links into the page. If a button still
// has the generic /releases/latest link (a local preview, or the deploy step didn't run), ask the
// GitHub API for the newest stable release and point it at the right DMG for that Mac.
(() => {
  const FALLBACK = "https://github.com/mbsoft/waterboy/releases/latest";
  const buttons = [...document.querySelectorAll("a[data-download]")];
  if (!buttons.some((a) => a.href === FALLBACK)) return;
  fetch("https://api.github.com/repos/mbsoft/waterboy/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      if (!rel || !Array.isArray(rel.assets)) return;
      const dmg = (arch) => rel.assets.find((x) => new RegExp(`-${arch}\\.dmg$`).test(x.name));
      for (const a of buttons) {
        const asset = dmg(a.dataset.download);
        if (asset && a.href === FALLBACK) a.href = asset.browser_download_url;
      }
      const v = document.querySelector("[data-release-version]");
      if (v && rel.tag_name) v.textContent = `Version ${rel.tag_name.replace(/^v/, "")}`;
    })
    .catch(() => {}); // the generic link still works
})();
