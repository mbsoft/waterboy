// Line icons (18px, currentColor). Static strings only; never built from data.
window.ICONS = (() => {
  const s = (body, size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const p = {
    dashboard: '<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="6" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5"/>',
    connections: '<path d="M10 14a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
    conversations: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14c2.3.2 4 1.7 4.5 4.3"/>',
    memory: '<path d="M12 4.5c-1.2-1.3-3.6-1.4-5 0-1 1-1.2 2.3-.8 3.4C4.6 8.4 3.6 9.8 3.8 11.5c.2 1.5 1.2 2.5 2.4 2.9-.3 1.4.1 2.8 1.3 3.7 1.3 1 3.1 1 4.5 0"/><path d="M12 4.5c1.2-1.3 3.6-1.4 5 0 1 1 1.2 2.3.8 3.4 1.6.5 2.6 1.9 2.4 3.6-.2 1.5-1.2 2.5-2.4 2.9.3 1.4-.1 2.8-1.3 3.7-1.3 1-3.1 1-4.5 0"/><path d="M12 4.5v13.6"/><path d="M8.5 9.5c1 .2 1.8.9 2 2M15.5 9.5c-1 .2-1.8.9-2 2"/>',
    automations: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 8v4.2l2.8 1.8"/>',
    logs: '<path d="M6 3h9l3 3v6"/><path d="M6 3v18h6"/><path d="M9 8h6M9 12h4"/><circle cx="16.5" cy="16.5" r="3"/><path d="m21 21-2.3-2.3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.6v.1"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4.5h-4.5"/>',
    sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M9 4.5v15"/><path d="M5.5 8h1.5M5.5 11h1.5"/>',
    play: '<path d="M7 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
    pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
    pauseSolid: '<path d="M8 6v12M16 6v12" stroke-width="3"/>',
    restart: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4.5h4.5"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8.2 12.3 2.6 2.6 5-5.3"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.4v.1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/><path d="M9 7V4.5h6V7"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    coffee: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10.5h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3.5c-.6.8-.6 1.7 0 2.5M11.5 3.5c-.6.8-.6 1.7 0 2.5"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><path d="M15 13v4M13 15h4"/>',
    pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>',
    message: '<path d="M4 5.5h16v10H9l-5 4z"/>',
    tool: '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3z"/><path d="M14.5 6.5 17 4l3 3-2.5 2.5"/>',
    server: '<rect x="3.5" y="4" width="17" height="7" rx="1.5"/><rect x="3.5" y="13" width="17" height="7" rx="1.5"/><path d="M7 7.5h.1M7 16.5h.1"/>',
    bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  };
  const out = {};
  for (const [k, v] of Object.entries(p)) out[k] = (size) => s(v, size);
  return out;
})();
