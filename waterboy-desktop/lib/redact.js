/**
 * Screenshot redaction (`npm run capture:redacted`). `redactPage` runs inside the page just
 * before a capture: phone numbers, emails, people's names, the home-folder path and free-text
 * memory are replaced with random characters of the same shape and then blurred, so the
 * original text isn't in the image at all (blur alone can sometimes be reversed).
 */

/** Page-side function; serialized with toString(), so it must be self-contained. */
function redactPage({ names, homeUser }) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // emails
    /\+?\d[\d\s().-]{8,}\d/g, // phone numbers (and other long digit runs)
    ...(homeUser ? [new RegExp(`(?<=/Users/)${esc(homeUser)}\\b`, "g")] : []),
    ...(names.length ? [new RegExp(`(?<![\\w])(?:${names.map(esc).sort((a, b) => b.length - a.length).join("|")})(?![\\w])`, "g")] : []),
  ];
  const letters = "aeonsrtlcdmhu";
  const scramble = (s) =>
    s.replace(/[A-Za-z]/g, (c) => {
      const r = letters[Math.floor(Math.random() * letters.length)];
      return c === c.toUpperCase() ? r.toUpperCase() : r;
    }).replace(/\d/g, () => String(Math.floor(Math.random() * 10)));
  const matches = (text) => {
    const found = [];
    for (const re of patterns) for (const m of text.matchAll(re)) found.push([m.index, m.index + m[0].length]);
    found.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const f of found) {
      const last = merged[merged.length - 1];
      if (last && f[0] <= last[1]) last[1] = Math.max(last[1], f[1]);
      else merged.push([...f]);
    }
    return merged;
  };

  if (!document.getElementById("redact-style")) {
    const style = document.createElement("style");
    style.id = "redact-style";
    style.textContent = ".redact{display:inline-block;filter:blur(5px);user-select:none}textarea.redact-field{filter:blur(4px)}";
    document.head.append(style);
  }

  // Text on the page.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  // Dropdown options and text areas are handled below (native controls can't show the blur).
  while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest(".redact,script,style,select,option,textarea")) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const ranges = matches(text);
    if (!ranges.length) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [a, b] of ranges) {
      if (a > pos) frag.append(text.slice(pos, a));
      const span = document.createElement("span");
      span.className = "redact";
      span.textContent = scramble(text.slice(a, b));
      frag.append(span);
      pos = b;
    }
    if (pos < text.length) frag.append(text.slice(pos));
    node.replaceWith(frag);
  }

  // Form fields: free-text memory is scrambled whole; other fields only where something matched.
  for (const el of document.querySelectorAll("textarea")) {
    if (!el.value.trim()) continue;
    el.value = scramble(el.value);
    el.classList.add("redact-field");
  }
  // Inputs and dropdowns are drawn natively and ignore CSS blur, so matches become dots there.
  const dots = (v) => {
    let out = v;
    for (const [a, b] of matches(v).reverse()) out = out.slice(0, a) + "•".repeat(Math.min(b - a, 10)) + out.slice(b);
    return out;
  };
  for (const el of document.querySelectorAll("input[type=text], input:not([type])")) el.value = dots(el.value);
  for (const sel of document.querySelectorAll("select")) for (const opt of sel.options) opt.text = dots(opt.text);
  // Initials in avatars hint at names.
  for (const el of document.querySelectorAll(".avatar")) if (/^[A-Z#]{1,2}$/.test(el.textContent.trim())) el.textContent = "•";
}

/** Names to hide: contacts, fantasy owner overrides, and the Mac user's own name. */
function namesToRedact(cfg, extra = []) {
  const names = new Set(extra);
  for (const v of Object.values(cfg.contacts ?? {})) names.add(v);
  for (const v of Object.values(cfg.fantasy?.ownerNames ?? {})) names.add(v);
  // "Kathy & Lee L." → also "Kathy", "Lee L."
  for (const n of [...names]) for (const part of n.split(/\s*&\s*|\s+and\s+/)) if (part.length > 2) names.add(part.trim());
  return [...names].filter((n) => n && n.length > 1);
}

module.exports = { redactPage, namesToRedact };
