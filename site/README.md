# Waterboy landing page

The static page served by GitHub Pages at <https://mbsoft.github.io/waterboy/>. Plain HTML, CSS and a
little JS: no build step, no frameworks, no web fonts or CDNs.

- `index.html`: the page. All copy lives here.
- `assets/css/style.css`: styles. Light and dark follow the system (`prefers-color-scheme`).
- `assets/js/site.js`: download-link fallback (below).
- `assets/img/`: icon, favicons, `og.png` (1200×630 link preview, cropped from the app's banner), and
  `cards/`, the sample cards.
- `tools/render-cards.ts`: renders `assets/img/cards/*.png` with the app's real card code from
  fictional data (no network): `cd waterboy-agent && npx tsx ../site/tools/render-cards.ts` (Node 22).

**Preview locally:** open `index.html` in a browser, or `npx serve site` from the repo root.

**Download links.** Every download link carries `data-download="arm64"` or `data-download="x64"` and,
in the source, points at `https://github.com/mbsoft/waterboy/releases/latest`. The Pages deploy
replaces those `href`s with the newest stable release's DMG URLs. If a link still has the generic
URL when the page loads (a local preview, or the deploy step didn't run), `site.js` asks the GitHub
API for the latest release and fills it in, along with the `[data-release-version]` text.

**Rules for content:** no real people, phone numbers or leagues (every name in the mockups and cards
is made up), macOS 12+, and no `brew install` line until the Homebrew tap exists.
