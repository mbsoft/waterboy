// Download buttons: written at deploy time by scripts/site-links.mjs (.github/workflows/pages.yml).
// This refreshes them from the GitHub API in case the deployed page is older than the newest
// stable release (releases/latest never returns drafts or betas). Without JS the static links work.
(() => {
  const REPO = "mbsoft/waterboy";
  const all = (sel) => Array.from(document.querySelectorAll(sel));
  if (!all("[data-download]").length) return;

  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      if (!rel || !rel.tag_name) return;
      const version = rel.tag_name.replace(/^v/, "");
      const dmg = (arch) => rel.assets.find((a) => a.name === `Waterboy-${version}-${arch}.dmg`)?.browser_download_url;
      const arm64 = dmg("arm64");
      const x64 = dmg("x64");
      if (!arm64 || !x64) return;

      // Before the first stable deploy the page has a single "Releases" link: swap in the two buttons.
      for (const link of all('[data-download="releases"]')) {
        const intel = link.cloneNode();
        link.dataset.download = "arm64";
        link.textContent = "Download for Apple silicon";
        intel.dataset.download = "x64";
        intel.classList.add("secondary");
        intel.textContent = "Download for Intel";
        link.after(" ", intel);
      }
      for (const a of all('[data-download="arm64"]')) Object.assign(a, { href: arm64 }).dataset.version = version;
      for (const a of all('[data-download="x64"]')) Object.assign(a, { href: x64 }).dataset.version = version;
      for (const el of all('[data-download="version"]')) el.textContent = version;
      for (const a of all('[data-download="notes"]')) a.href = rel.html_url;
      for (const a of all('[data-download="sums"]')) a.href = `https://github.com/${REPO}/releases/download/${rel.tag_name}/SHA256SUMS.txt`;
    })
    .catch(() => {}); // offline or rate-limited: keep the deployed links
})();
