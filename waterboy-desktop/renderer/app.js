/* global ICONS, SETTINGS_TABS */
(() => {
  const api = window.agent;
  const $ = (sel) => document.querySelector(sel);

  // ---------- tiny DOM helpers (text is always set as text, never parsed as HTML) ----------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "icon") el.insertAdjacentHTML("afterbegin", v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const icon = (name, size) => {
    const span = document.createElement("span");
    span.style.display = "inline-flex";
    span.innerHTML = ICONS[name](size);
    return span;
  };
  const card = (...children) => h("section", { class: "card" }, ...children);
  const pageHead = (title, desc, actions) =>
    h("div", { class: "page-head" }, h("div", {}, h("h2", {}, title), desc && h("p", {}, desc)), actions && h("div", { class: "actions" }, actions));

  function toggle(checked, onchange, label) {
    const input = h("input", { type: "checkbox", role: "switch", checked, "aria-label": label });
    input.addEventListener("change", async () => {
      input.disabled = true;
      try {
        await onchange(input.checked);
      } catch (e) {
        input.checked = !input.checked;
        toast(e.message, true);
      } finally {
        input.disabled = false;
      }
    });
    return h("label", { class: "switch" }, input, h("span"));
  }

  function button(label, onclick, { primary, danger, iconName, lg, title } = {}) {
    const b = h("button", { class: `btn${primary ? " primary" : ""}${danger ? " danger" : ""}${lg ? " lg" : ""}`, title });
    if (iconName) b.append(icon(iconName, 14));
    b.append(label);
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await onclick(b);
      } catch (e) {
        toast(e.message, true);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  // Buy Me a Coffee's official button is a remote script (cdnjs.buymeacoffee.com). The renderer's
  // CSP is script-src 'self' and a desktop app should not run third-party code next to the IPC
  // bridge, so this draws the same button from BMC's own attributes (#FFDD00, black outline and
  // text, Arial, the 🍺 emoji) and opens the link in the browser instead.
  function bmcButton() {
    const b = h("button", { class: "bmc-btn", title: "buymeacoffee.com/jgauntlettk" },
      h("span", { class: "bmc-emoji" }, "\u{1F37A}"),
      h("span", { class: "bmc-text" }, "'Beer me!'"),
    );
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api.openSupport();
      } catch (e) {
        toast(e.message, true);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  function toast(text, error = false) {
    const t = h("div", { class: `toast${error ? " error" : ""}` }, icon(error ? "alert" : "check", 16), h("div", {}, text));
    $("#toasts").append(t);
    setTimeout(() => t.remove(), error ? 7000 : 3200);
  }

  const initials = (name) =>
    (name || "?")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("") || "#";

  function relTime(iso) {
    if (!iso) return "";
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  const stamp = (iso) => {
    const d = new Date(iso);
    const today = d.toDateString() === new Date().toDateString();
    return today
      ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })
      : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  };

  // ---------- app shell ----------

  const PAGES = [
    { id: "dashboard", title: "Dashboard", icon: "dashboard" },
    { id: "connections", title: "Connections", icon: "connections" },
    { id: "conversations", title: "Conversations", icon: "conversations" },
    { id: "memory", title: "Memory", icon: "memory" },
    { id: "automations", title: "Automations", icon: "automations" },
    { id: "logs", title: "Logs", icon: "logs" },
    { id: "settings", title: "Settings", icon: "settings" },
    { id: "about", title: "About", icon: "about" },
    { id: "setup", title: "Setup", icon: "settings", hidden: true },
  ];
  const state = { overview: null, logPage: 0, logFilter: "all", memoryDir: null, newAutomation: false, editAutomation: null, focusSetting: null };

  function buildShell() {
    const nav = $("#nav");
    for (const p of PAGES.filter((p) => !p.hidden)) {
      const a = h("a", { href: `#${p.id}`, "data-page": p.id, title: p.title }, icon(p.icon, 18), h("span", {}, p.title));
      nav.append(a);
    }
    $("#sidebar-toggle").innerHTML = ICONS.sidebar(19);
    $("#refresh").innerHTML = ICONS.refresh(17);
    $("#sidebar-toggle").addEventListener("click", () => {
      $("#app").classList.toggle("collapsed");
      try {
        localStorage.setItem("collapsed", $("#app").classList.contains("collapsed") ? "1" : "");
      } catch {}
    });
    try {
      if (localStorage.getItem("collapsed")) $("#app").classList.add("collapsed");
    } catch {}
    $("#refresh").addEventListener("click", () => render(true));
    $("#content").addEventListener("scroll", syncScroll);
    window.addEventListener("hashchange", () => {
      $("#content").scrollTop = 0;
      render();
    });
  }

  // Routes are #page, or #settings/<tab> for a Settings tab.
  const current = () => PAGES.find((p) => p.id === SETTINGS_TABS.parseRoute(location.hash).page) ?? PAGES[0];

  async function refreshOverview() {
    try {
      state.overview = await api.overview();
    } catch (e) {
      state.overview = null;
      toast(e.message, true);
    }
    const o = state.overview;
    const foot = $("#sidebar-foot");
    foot.replaceChildren();
    if (o?.startupError && o.status.installed) foot.append(icon("alert", 13), "Can't start");
    else if (o) foot.append(o.status.running ? h("span", { class: "pulse" }) : icon("pause", 13), o.status.running ? "Running" : o.status.installed ? "Paused" : "Not installed");
    const logsLink = $('#nav a[data-page="logs"]');
    logsLink.querySelector(".badge")?.remove();
    if (o?.summary.errorsToday) logsLink.append(h("span", { class: "badge" }, o.summary.errorsToday));
  }

  // The toolbar border shows once the page scrolls; the toolbar title only once the page's own
  // heading has scrolled out of view, so the title never appears twice.
  function syncScroll() {
    const top = $("#content").scrollTop;
    $("#main").classList.toggle("scrolled", top > 4);
    $("#main").classList.toggle("titled", top > 56);
  }

  let renderSeq = 0;
  async function render(spinning = false) {
    const page = current();
    const seq = ++renderSeq;
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === page.id));
    $("#page-title").textContent = page.title;
    document.title = `${page.title} · Waterboy`;
    const refresh = $("#refresh");
    if (spinning) refresh.classList.add("spin");
    const content = $("#content");
    if (!content.firstChild || content.dataset.page !== page.id) content.replaceChildren(h("div", { class: "page" }, h("div", { class: "skeleton" }), h("div", { class: "skeleton" })));
    try {
      await refreshOverview();
      const el = await RENDER[page.id]();
      if (seq !== renderSeq) return;
      content.dataset.page = page.id;
      content.replaceChildren(el);
      if (state.focusSetting) focusSetting(state.focusSetting);
      syncScroll();
    } catch (e) {
      if (seq !== renderSeq) return;
      content.replaceChildren(h("div", { class: "page" }, card(h("div", { class: "empty" }, icon("alert", 18), e.message))));
    } finally {
      refresh.classList.remove("spin");
    }
  }

  // Links like the Dashboard's data sources open a Settings tab at one control and highlight it.
  function focusSetting(key) {
    state.focusSetting = null;
    const el = document.querySelector(`[data-setting="${CSS.escape(key)}"]`);
    if (!el) return;
    const target = el.closest(".toggle-label, .inline") ?? el;
    const label = target.previousElementSibling?.tagName === "LABEL" ? target.previousElementSibling : null;
    target.scrollIntoView({ block: "center" });
    for (const x of [target, label]) x?.classList.add("flash");
    (el.matches("input, select") ? el : el.querySelector("input"))?.focus({ preventScroll: true });
  }
  const openSetting = (key) => {
    state.focusSetting = key;
    location.hash = "#settings/fantasy";
  };

  function restartBanner() {
    const o = state.overview;
    if (!o?.needsRestart) return null;
    return h(
      "div",
      { class: "banner" },
      icon("restart", 18),
      h("div", { class: "grow" }, "Settings changed since the agent started. Restart it to apply them."),
      button("Restart now", async () => {
        await api.restart();
        toast("Agent restarted");
        render();
      }, { primary: true }),
    );
  }
  // Problems with the service bundled in this app, or a service still running from a source checkout.
  function setupBanner() {
    const setup = state.overview?.setup;
    if (!setup?.bundled) return null;
    if (setup.state === "error") return h("div", { class: "banner warn" }, icon("alert", 18), h("div", { class: "grow" }, `Couldn't set up the service: ${setup.error}`));
    if (setup.state === "blocked" && setup.installed) return h("div", { class: "banner warn" }, icon("alert", 18), h("div", { class: "grow" }, setup.reason));
    if (setup.state !== "source") return null;
    return h(
      "div",
      { class: "banner" },
      icon("restart", 18),
      h("div", { class: "grow" }, `The service is running from ${setup.project ?? "a source checkout"}. Switch to the version that comes with this app? Its config.json is copied to ~/.imessage-agent if there isn't one there.`),
      button("Switch", async () => {
        await api.installService();
        toast("Now using the service bundled with the app");
        render();
      }, { primary: true }),
    );
  }
  // A downloaded app update, waiting for a restart.
  function updateBanner() {
    const u = state.overview?.update;
    if (u?.state !== "ready") return null;
    return h(
      "div",
      { class: "banner" },
      icon("restart", 18),
      h("div", { class: "grow" }, `Waterboy ${u.version} is ready. Restart the app to update; the agent restarts on the new version too.`),
      button("Restart to update", () => api.installUpdate(), { primary: true }),
    );
  }
  const saved = (what = "Saved") => toast(state.overview?.status.running ? `${what}. Restart the agent to apply.` : what);

  // ---------- pages ----------

  const RENDER = {};

  RENDER.dashboard = async () => {
    const o = state.overview;
    if (!o) throw new Error("Couldn't reach the agent.");
    const usage = await api.usage().catch(() => null);
    const s = o.status;
    const name = o.agentName;
    let statusBody;
    const setup = o.setup ?? {};
    if (!s.installed)
      statusBody = [
        h("div", { class: "status-icon" }, icon("alert", 18)),
        h(
          "div",
          { class: "grow" },
          h("h4", {}, "Not installed"),
          h("p", {}, setup.state === "blocked" ? setup.reason : setup.bundled ? "Install the Waterboy service so it can reply to your messages." : "Run npm run install-service in the agent project to set it up."),
        ),
        setup.bundled && setup.state !== "blocked"
          ? button("Install service", async () => {
              await api.installService();
              toast("Service installed");
              render();
            }, { primary: true, lg: true, iconName: "play" })
          : null,
      ];
    else if (o.startupError)
      // The service is up but refused to touch the data (it waits instead of crash-looping).
      statusBody = [
        h("div", { class: "status-icon" }, h("span", { class: "bad-icon" }, icon("alert", 18))),
        h("div", { class: "grow" }, h("h4", {}, "Can't start"), h("p", {}, o.startupError.message)),
        button("Restart", async () => {
          await api.restart();
          render();
        }, { iconName: "restart" }),
      ];
    else if (s.running)
      statusBody = [
        h("div", { class: "status-icon running" }, h("span", { class: "pulse" })),
        h(
          "div",
          { class: "grow" },
          h("h4", {}, "Running"),
          h("p", {}, `${name} is replying in ${o.readiness.conversations.detail.replace(" allowed", "")} allowed conversation${o.readiness.conversations.detail.startsWith("1 ") ? "" : "s"} and running automations.${s.startedAt ? ` Started ${relTime(s.startedAt)}.` : ""}`),
        ),
        h(
          "div",
          { class: "inline" },
          button("Restart", async () => {
            await api.restart();
            toast(`${name} restarted`);
            render();
          }, { iconName: "restart" }),
          button("Pause", async () => {
            await api.pause();
            toast(`${name} paused`);
            render();
          }, { iconName: "pauseSolid" }),
        ),
      ];
    else
      statusBody = [
        h("div", { class: "status-icon" }, icon("pause", 20)),
        h("div", { class: "grow" }, h("h4", {}, "Paused"), h("p", {}, `${name} will not reply or run scheduled work.`)),
        button(`Start ${name}`, async () => {
          const st = await api.start();
          toast(st.running ? `${name} started` : `${name} didn't start. Check Logs.`, !st.running);
          render();
        }, { primary: true, lg: true, iconName: "play" }),
      ];

    const r = o.readiness;
    const check = (label, c) =>
      h("div", { class: "check" }, h("span", { class: c.ok ? "ok-icon" : "bad-icon" }, icon(c.ok ? "check" : "alert", 17)), h("span", { class: "label" }, label), h("span", { class: "detail" }, c.detail));

    const sm = o.summary;
    return h(
      "div",
      { class: "page" },
      pageHead("Dashboard", "See the agent's status, readiness and today's activity."),
      setupBanner(),
      updateBanner(),
      restartBanner(),
      usageBanner(usage),
      card(h("h3", {}, `${name} status`), h("div", { class: "status" }, statusBody)),
      r.sending?.failing
        ? h(
            "div",
            { class: "banner warn" },
            icon("alert", 18),
            h(
              "div",
              { class: "grow" },
              `Sending through Messages is failing: ${r.sending.detail}. After a macOS update, allow Waterboy again under System Settings → Privacy & Security → Automation → Messages, then restart ${name}.`,
            ),
          )
        : null,
      card(
        h(
          "div",
          { class: "readiness" },
          h("h3", {}, "Setup readiness"),
          h(
            "div",
            { class: "checks" },
            check(r.provider === "chatgpt" ? "ChatGPT" : "Claude Code", r.claude),
            check("Messages", r.messages),
            // The banner above carries the full failure detail
            check("Sending", r.sending ? (r.sending.failing ? { ok: false, detail: "Failing" } : r.sending) : { ok: true, detail: "Not checked yet" }),
            check("Conversations", r.conversations),
          ),
        ),
        // The service's own checks (the ones `npm run doctor` runs) and data sources that are down:
        // only what needs attention
        r.checks?.attention.length || r.sources?.down.length
          ? h(
              "div",
              { class: "attention" },
              r.sources?.down.length
                ? h(
                    "div",
                    { class: "attention-row" },
                    h("span", { class: "bad-icon" }, icon("alert", 17)),
                    h(
                      "div",
                      {},
                      h("div", { class: "label" }, r.sources.down.length > 1 ? `${r.sources.down.length} data sources are down` : `${r.sources.down[0]} is down`),
                      h("div", { class: "detail" }, `${r.sources.down.length > 1 ? `${r.sources.down.join(", ")}: no` : "No"} successful call in 6 hours. See Data sources below.`),
                    ),
                  )
                : null,
              ...(r.checks?.attention ?? []).map((c) =>
                h(
                  "div",
                  { class: "attention-row" },
                  // Everything listed needs attention; optional items are grey rather than orange
                  h("span", { class: c.ok ? "muted-icon" : "bad-icon" }, icon("alert", 17)),
                  h("div", {}, h("div", { class: "label" }, c.label), h("div", { class: "detail" }, c.hint ? `${c.detail}. ${c.hint}` : c.detail)),
                ),
              ),
            )
          : null,
        r.checks
          ? h("p", { class: "note" }, r.checks.attention.length ? `Service checks from ${stamp(new Date(r.checks.checkedAt).toISOString())}.` : `${r.checks.total === 1 ? "The service check" : `All ${r.checks.total} service checks`} passed (${stamp(new Date(r.checks.checkedAt).toISOString())}).`)
          : null,
      ),
      sourcesCard(r.sources),
      card(
        h("h3", {}, "Today"),
        h(
          "div",
          { class: "stats", style: "margin-top:10px" },
          stat(sm.repliesToday, "Replies"),
          stat(sm.avgSeconds !== null ? `${sm.avgSeconds} s` : "–", "Avg. reply time"),
          stat(sm.ignoredToday, "Ignored messages"),
          stat(sm.errorsToday, "Problems"),
          h("div", { class: "right" }, h("div", { class: "lbl" }, "Last reply"), h("div", {}, sm.lastReplyAt ? stamp(sm.lastReplyAt) : "None yet")),
        ),
        sm.ignoredToday ? h("p", { class: "note" }, "Ignored messages came from conversations that aren't allowed. You can allow them in Conversations.") : null,
      ),
      usageCard(usage),
      card(
        h("h3", {}, `Use ${name} in Messages`),
        h("p", { class: "desc", style: "color:var(--text);margin-top:8px" }, `Text ${name} from an allowed conversation. In group chats, mention ${name} by name to get a reply.`),
        h("p", { class: "desc" }, "Try /help in a chat for commands like /new, /memory, /pause and /status."),
        h("div", { class: "inline", style: "gap:18px" }, linkTo("conversations", "Manage conversations", "conversations"), linkTo("settings", "Open Settings", "settings"), linkTo("setup", "Run setup again", "check")),
      ),
    );
  };
  // ---------- usage (Dashboard) ----------

  const money = (usd) => (usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`);
  const tokenCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const turnCount = (n) => `${n} turn${n === 1 ? "" : "s"}`;

  /** Today's cost reached usage.dailyCostAlertUsd: warn once per local day (dismissing hides it until tomorrow). */
  function usageBanner(u) {
    const a = u?.alert;
    if (!a?.crossed || localStorage.getItem("usageAlertDismissed") === a.day) return null;
    const el = h(
      "div",
      { class: "banner warn" },
      icon("alert", 18),
      h("div", { class: "grow" }, `Today's usage is ${money(a.todayCostUsd)} (API-equivalent), over your ${money(a.thresholdUsd)} daily alert. Nothing was sent to your chats.`),
      h("button", { class: "link", onclick: () => (location.hash = "#settings/advanced") }, "Change alert"),
      button("Dismiss", () => {
        localStorage.setItem("usageAlertDismissed", a.day);
        el.remove();
      }),
    );
    return el;
  }

  /** Cost (Claude) or tokens (ChatGPT) over the last 30 days, with breakdowns. */
  function usageCard(u) {
    if (!u) return null;
    const usd = u.unit === "usd";
    const head = h("div", { class: "card-head" }, h("h3", {}, "Usage"), h("span", { class: "meta" }, usd ? "API-equivalent cost" : "Tokens (ChatGPT has no per-reply cost)"));
    if (!u.available || !u.month.turns)
      return card(head, h("p", { class: "desc", style: "margin-top:8px" }, u.available ? "No turns in the last 30 days. Usage shows up here a few seconds after the next reply." : "Usage shows up here once the agent has been restarted on this version and has replied."));
    const value = (g) => (usd ? money(g.costUsd) : tokenCount(g.tokens));
    const total = (g, lbl) => h("div", { class: "stat" }, h("div", { class: "num" }, value(g)), h("div", { class: "lbl" }, `${lbl} · ${turnCount(g.turns)}`));
    const measure = (g) => (usd ? g.costUsd : g.tokens);

    // One bar per local day; hover a bar for its numbers
    const max = Math.max(...u.days.map(measure));
    const fmtDay = (day, opts) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, opts);
    const bars = h("div", { class: "usage-bars", role: "img", "aria-label": `Daily ${usd ? "cost" : "tokens"} for the last 30 days, up to ${usd ? money(max) : tokenCount(max)} a day` },
      u.days.map((d, i) =>
        h("div", { class: `usage-bar${i === u.days.length - 1 ? " today" : ""}`, title: `${fmtDay(d.day, { weekday: "short", month: "short", day: "numeric" })}: ${value(d)} · ${turnCount(d.turns)}` },
          h("span", { style: `height:${max ? Math.max(measure(d) ? 2 : 0, (measure(d) / max) * 100) : 0}%` }))));
    const chart = h("div", { class: "usage-chart" },
      h("div", { class: "usage-max" }, usd ? money(max) : tokenCount(max)),
      bars,
      h("div", { class: "usage-axis" }, h("span", {}, fmtDay(u.days[0].day, { month: "short", day: "numeric" })), h("span", {}, "Today")));

    // A breakdown: name, a thin bar for its share, the value
    const top = (groups) => Math.max(...groups.map(measure), 0);
    const breakdown = (title, groups, more) => {
      const m = top(groups);
      return h("div", { class: "usage-breakdown" },
        h("div", { class: "lbl" }, title),
        groups.map((g) =>
          h("div", { class: "usage-row", title: `${g.name}: ${value(g)} · ${turnCount(g.turns)}` },
            h("span", { class: "name" }, g.name),
            h("span", { class: "share" }, h("span", { style: `width:${m ? (measure(g) / m) * 100 : 0}%` })),
            h("span", { class: "val" }, value(g)))),
        more ? h("div", { class: "note", style: "margin-top:4px" }, `and ${more} more`) : null);
    };
    const KIND = { reply: "Replies", scheduled: "Automations", alert: "Live alerts" };
    const kinds = u.byKind.filter((k) => k.turns).map((k) => ({ ...k, name: `${KIND[k.key]} (${k.turns})` }));
    return card(
      head,
      h("div", { class: "stats", style: "margin-top:10px" }, total(u.today, "Today"), total(u.week, "7 days"), total(u.month, "30 days")),
      chart,
      h("div", { class: "usage-breakdowns" },
        breakdown("By model", u.byModel),
        breakdown("Top chats", u.byChat, u.otherChats),
        breakdown("By kind", kinds)),
      h("p", { class: "note" },
        usd
          ? "API-equivalent is what these turns would cost at Anthropic's API prices. Your Claude plan's usage limits are what actually apply. Live alerts are written by Waterboy and cost nothing."
          : "ChatGPT plans don't report a cost per reply, so this shows tokens used. They count toward your plan's limits."),
    );
  }

  // Fantasy data sources (health.json from the service): one row each, problems first in the text.
  function sourcesCard(src) {
    if (!src) return null;
    const head = h("div", { class: "card-head" }, h("h3", {}, "Data sources"), h("div", { class: "actions" }, h("button", { class: "link", onclick: () => (location.hash = "#settings/fantasy") }, icon("settings", 16), "Fantasy settings")));
    if (src.stale) return card(head, h("div", { class: "empty" }, icon("alert", 18), "Not checked recently (is the service running?)"));
    const ago = (ms) => relTime(new Date(ms).toISOString());
    const pct = (x) => `${Math.round(x * 1000) / 10}%`.replace(".0%", "%");
    const since = src.startedAt ? `since the agent started ${ago(src.startedAt)}` : "since the agent started";
    const name = { ok: "OK", degraded: "Degraded", down: "Down", off: "Off", unknown: "No data" };
    const pill = { ok: "pill ok", degraded: "pill warn", down: "pill bad", off: "pill", unknown: "pill" };
    const summary = (x) => {
      const okRate = x.okRate24h !== null && x.calls24h ? `${pct(x.okRate24h)} of ${x.calls24h} call${x.calls24h === 1 ? "" : "s"} OK in 24 h` : null;
      const avg = x.avgMs !== null ? `${x.avgMs < 1000 ? `${x.avgMs} ms` : `${(x.avgMs / 1000).toFixed(1)} s`} avg` : null;
      switch (x.status) {
        case "off":
          return x.id === "espn" ? "Fantasy football isn't set up" : "Turned off in Settings";
        case "unknown":
          return `No data ${since}`;
        case "down":
          return [x.lastOkAt ? `No success since ${ago(x.lastOkAt)}` : `No success ${since}`, okRate].filter(Boolean).join(" · ");
        default:
          return [x.lastOkAt ? `Last OK ${ago(x.lastOkAt)}` : null, okRate, avg].filter(Boolean).join(" · ");
      }
    };
    const rows = src.list.map((x) => {
      const nfl = x.id === "nflverse" && x.status !== "off" && x.dataUpdatedAt
        ? h("span", { class: x.dataStale ? "src-data stale" : "src-data" }, `${x.dataStale ? "Data is old: " : "Data "}downloaded ${ago(x.dataUpdatedAt)}`)
        : null;
      // The last error stays visible after a recovery, folded away unless the source has a problem
      const err = x.lastError && x.status !== "off"
        ? h("details", { class: "src-error", open: x.status === "down" || x.status === "degraded" }, h("summary", {}, `Last error ${x.lastErrorAt ? ago(x.lastErrorAt) : ""}`.trim()), h("code", {}, x.lastError))
        : null;
      return h(
        "div",
        { class: `src-row ${x.status}`, "data-source": x.id },
        h("span", { class: `src-dot ${x.status}`, title: name[x.status] }),
        h("div", { class: "grow" }, h("div", { class: "title" }, x.label), h("div", { class: "sub" }, summary(x)), nfl, err),
        h("span", { class: pill[x.status] }, name[x.status]),
        h("button", { class: "link src-link", title: `Settings → Fantasy`, onclick: () => openSetting(x.setting) }, "Settings"),
      );
    });
    // The service keeps these in memory: after a restart, "No data" isn't a problem, just no use yet
    const restarted = src.list.some((x) => x.status === "unknown") ? " The numbers start over when the agent restarts; a source shows up once it's used." : "";
    return card(
      head,
      h("div", { class: "rows" }, rows),
      h("p", { class: "note" }, `Updated ${stamp(new Date(src.checkedAt).toISOString())}. Down means no successful call in 6 hours.${restarted}`),
    );
  }
  const stat = (num, lbl) => h("div", { class: "stat" }, h("div", { class: "num" }, num), h("div", { class: "lbl" }, lbl));
  const linkTo = (page, label, iconName) => h("button", { class: "link", onclick: () => (location.hash = `#${page}`) }, icon(iconName, 16), label);

  RENDER.connections = async () => {
    const [c, s] = await Promise.all([api.connections(), api.settings()]);
    const toolName = (t) => {
      const m = t.match(/^mcp__(.+?)__(.+)$/);
      if (!m) return { group: "Built-in", tool: t };
      return { group: m[1].replace(/^claude_ai_/, "").replace(/_/g, " "), tool: m[2] };
    };
    return h(
      "div",
      { class: "page" },
      pageHead("Connections", "Tools and MCP servers the agent can use."),
      restartBanner(),
      calendarCard(s),
      card(
        h("h3", {}, "Built-in tools"),
        h("p", { class: "desc" }, "Group chats only get fantasy football and the scheduler. Everything else is limited to 1:1 conversations."),
        h("div", { class: "rows" }, c.builtIn.map((b) => h("div", { class: "row" }, h("span", { class: "avatar" }, icon(b.name === "Scheduler" ? "calendar" : b.name === "Shell" ? "bolt" : "tool", 16)), h("div", { class: "grow" }, h("div", { class: "title" }, b.name), h("div", { class: "sub" }, b.detail))))),
      ),
      card(
        h("h3", {}, "MCP servers"),
        h("p", { class: "desc" }, "Servers from mcpServers in config.json. Every tool on a listed server is allowed in 1:1 conversations."),
        c.servers.length
          ? h("div", { class: "rows" }, c.servers.map((s) => h("div", { class: "row" }, h("span", { class: "avatar" }, icon("server", 16)), h("div", { class: "grow" }, h("div", { class: "title mono" }, s.name), h("div", { class: "sub mono" }, s.target)), h("span", { class: "pill" }, s.type))))
          : h("div", { class: "empty" }, icon("server", 18), "No MCP servers configured."),
        h("div", { class: "inline", style: "margin-top:10px" }, button("Edit config.json", () => api.open("config"), { iconName: "external" })),
      ),
      card(
        h("h3", {}, "Extra allowed tools"),
        c.provider === "chatgpt" ? h("p", { class: "desc" }, "Claude only. With ChatGPT, 1:1 chats can use every tool of the MCP servers above.") : null,
        h("p", { class: "desc" }, "Individual tools from connectors like Google Calendar that the agent may call without asking."),
        c.extraTools.length
          ? h(
              "div",
              { class: "rows" },
              c.extraTools.map((t) => {
                const n = toolName(t);
                return h(
                  "div",
                  { class: "row" },
                  h("div", { class: "grow" }, h("div", { class: "title" }, n.tool.replace(/_/g, " ")), h("div", { class: "sub mono" }, n.group)),
                  button("Remove", async () => {
                    await api.removeExtraTool(t);
                    saved("Removed");
                    render();
                  }, { danger: true }),
                );
              }),
            )
          : h("div", { class: "empty" }, icon("tool", 18), "No extra tools."),
      ),
    );
  };

  RENDER.conversations = async () => {
    const [conv, cfgTeams] = await Promise.all([api.conversations(), api.fantasyTeams().catch(() => null)]);
    const hasFantasy = !!(await api.settings()).fantasy;
    const directRows = conv.direct.map((d) => {
      const label = d.name || d.handle;
      const nameEl = h("div", { class: "title" }, label);
      const edit = h("button", { class: "icon-btn", title: "Rename", "aria-label": `Rename ${label}` }, icon("pencil", 14));
      edit.addEventListener("click", () => {
        const input = h("input", { type: "text", value: d.name ?? "", placeholder: "Name", style: "width:200px" });
        const save = async () => {
          if ((input.value.trim() || null) !== (d.name || null)) {
            await api.setContactName(d.handle, input.value).catch((e) => toast(e.message, true));
            saved();
          }
          render();
        };
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") render();
        });
        input.addEventListener("blur", save);
        nameEl.replaceWith(input);
        edit.remove();
        input.focus();
      });
      const row = h(
        "div",
        { class: "row" },
        h("span", { class: "avatar" }, initials(d.name || "")),
        h("div", { class: "grow" }, h("div", { class: "inline", style: "gap:4px" }, nameEl, edit), h("div", { class: "sub" }, [d.name ? d.handle : null, d.lastMessageAt ? `last message ${relTime(d.lastMessageAt)}` : null].filter(Boolean).join(" · ") || "No recent messages")),
        h("span", { class: "toggle-label" }, "Allow access", toggle(d.allowed, async (on) => {
          await api.setAllowed(d.handle, on);
          saved(on ? `${label} can now text the agent` : `${label} is no longer allowed`);
          render();
        }, `Allow ${label}`)),
      );
      if (!d.allowed) return row;
      const access = h("select", { "aria-label": `${label}'s access` }, h("option", { value: "full" }, "Everything"), h("option", { value: "fantasy" }, "Fantasy football only"));
      access.value = d.access;
      access.addEventListener("change", async () => {
        await api.setAccess(d.handle, access.value).catch((e) => toast(e.message, true));
        saved(access.value === "fantasy" ? `${label} is limited to fantasy football` : `${label} has full access`);
        render();
      });
      const extras = [
        h("span", { class: "field-inline" }, "Access", access),
        h("span", { class: "field-inline" }, "Admin", toggle(d.admin, async (on) => {
          await api.setAdmin(d.handle, on);
          saved();
          render();
        }, `${label} is admin`)),
      ];
      if (hasFantasy) {
        const sel = h("select", { "aria-label": `${label}'s fantasy team` }, h("option", { value: "" }, "None"));
        const names = cfgTeams ? cfgTeams.map((t) => t.name) : [];
        if (d.team && !names.includes(String(d.team))) names.unshift(String(d.team));
        for (const n of names) sel.append(h("option", { value: n }, n));
        sel.value = d.team ?? "";
        sel.addEventListener("change", async () => {
          await api.setTeam(d.handle, sel.value || null).catch((e) => toast(e.message, true));
          saved();
          render();
        });
        extras.push(h("span", { class: "field-inline" }, "Fantasy team", sel));
      }
      return [row, h("div", { class: "row-extra" }, extras)];
    });

    // "Add person": someone who hasn't texted yet (or an update to someone listed).
    const addForm = h("div", { class: "add-person", hidden: true });
    const openAdd = () => {
      const name = h("input", { type: "text", placeholder: "Name", "aria-label": "Name" });
      const handle = h("input", { type: "text", placeholder: "Phone number or email", "aria-label": "Phone number or email", class: "mono" });
      const access = h("select", { "aria-label": "Access" }, h("option", { value: "full" }, "Everything"), h("option", { value: "fantasy" }, "Fantasy football only"));
      const team = hasFantasy
        ? h("select", { "aria-label": "Fantasy team" }, h("option", { value: "" }, "No team"), (cfgTeams ?? []).map((t) => h("option", { value: t.name }, t.name)))
        : null;
      const close = () => {
        addForm.hidden = true;
        addForm.replaceChildren();
      };
      const add = button("Add", async () => {
        const r = await api.addPerson({ name: name.value, handle: handle.value, access: access.value, team: team?.value || null });
        saved(r.updated ? `Updated ${r.name}` : `${r.name} (${r.handle}) can now text the agent`);
        render();
      }, { primary: true });
      for (const input of [name, handle]) input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") add.click();
        if (e.key === "Escape") close();
      });
      addForm.replaceChildren(
        h("div", { class: "form" },
          h("label", {}, "Name"), name,
          h("label", {}, "Phone or email"), handle,
          h("div", { class: "hint" }, "The number or Apple Account email they text from. US numbers can be 10 digits; add + and the country code otherwise."),
          h("label", {}, "Access"), access,
          ...(team ? [h("label", {}, "Fantasy team"), team] : []),
        ),
        h("div", { class: "inline", style: "justify-content:flex-end;margin-top:12px" }, button("Cancel", close), add),
      );
      addForm.hidden = false;
      name.focus();
    };

    const groupRows = conv.groups.map((g) => {
      const members = g.members.map((m) => m.name || m.handle);
      const shown = members.slice(0, 4).join(", ");
      return h(
        "div",
        { class: "row" },
        h("span", { class: "avatar group" }, icon("conversations", 16)),
        h("div", { class: "grow" }, h("div", { class: "title" }, g.name || "Unnamed group"), h("div", { class: "sub" }, `${shown}${members.length > 4 ? `  +${members.length - 4} more` : ""}`)),
        h("span", { class: "meta" }, relTime(g.lastMessageAt)),
        h("span", { class: "toggle-label" }, "Allow access", toggle(g.allowed, async (on) => {
          await api.setAllowed(g.name || g.guid, on);
          saved();
          render();
        }, `Allow ${g.name || "group"}`)),
      );
    });

    return h(
      "div",
      { class: "page" },
      pageHead("Conversations", "Choose who can talk to the agent."),
      restartBanner(),
      card(
        h("div", { class: "card-head" }, h("h3", {}, "Direct messages"), button("Add person", openAdd, { iconName: "plus" })),
        addForm,
        h("p", { class: "desc" }, "Allowed people can text the agent. With Everything they can use all its tools and files; with Fantasy football only, their chat works like the league group and anything else gets a polite no. Admins can pause the agent and manage scheduled posts in group chats."),
        directRows.length ? h("div", { class: "rows" }, directRows) : h("div", { class: "empty" }, icon("message", 18), "No conversations yet."),
        h("p", { class: "note" }, `Can't find someone? Add them with Add person, or have them send a message to this Mac once. The list updates every 5 minutes while the agent is running${conv.indexUpdatedAt ? ` (last updated ${relTime(conv.indexUpdatedAt)})` : ""}.`),
      ),
      card(
        h("h3", {}, "Group conversations"),
        h("p", { class: "desc" }, "Allow a group only when you trust everyone in it. In groups the agent handles fantasy football only, and replies when someone mentions it."),
        groupRows.length ? h("div", { class: "rows" }, groupRows) : h("div", { class: "empty" }, icon("conversations", 18), "No group chats yet."),
      ),
    );
  };

  RENDER.memory = async () => {
    const mems = await api.memories();
    if (!mems.length)
      return h("div", { class: "page" }, pageHead("Memory", "What the agent remembers in each conversation."), card(h("div", { class: "empty" }, icon("memory", 18), "No conversations have memory yet.")));
    if (!mems.some((m) => m.dir === state.memoryDir)) state.memoryDir = (mems.find((m) => m.chars) ?? mems[0]).dir;
    const m = mems.find((x) => x.dir === state.memoryDir);
    const select = h("select", { style: "min-width:280px", "aria-label": "Conversation" }, mems.map((x) => h("option", { value: x.dir }, `${x.label}${x.chars ? "" : "  (empty)"}`)));
    select.value = m.dir;
    select.addEventListener("change", () => {
      state.memoryDir = select.value;
      render();
    });
    const area = h("textarea", { class: "mono", rows: 14, placeholder: m.isGroup ? "Group chats don't keep a memory file." : "Nothing saved yet. The agent adds notes here when someone asks it to remember something.", value: m.text });
    const saveBtn = button("Save", async () => {
      await api.saveMemory(m.dir, area.value);
      toast("Memory saved");
      render();
    }, { primary: true });
    saveBtn.disabled = true;
    area.addEventListener("input", () => (saveBtn.disabled = area.value === m.text));
    let confirmErase = false;
    const erase = button("Erase…", async (b) => {
      if (!confirmErase) {
        confirmErase = true;
        b.lastChild.textContent = "Click again to erase";
        b.classList.add("solid");
        setTimeout(() => {
          confirmErase = false;
          b.lastChild.textContent = "Erase…";
          b.classList.remove("solid");
        }, 3500);
        return;
      }
      await api.saveMemory(m.dir, "");
      toast("Memory erased");
      render();
    }, { danger: true });
    erase.disabled = !m.chars;

    return h(
      "div",
      { class: "page" },
      pageHead("Memory", "Review what the agent remembers for future replies in each conversation."),
      card(
        h("h3", {}, "Conversation memory"),
        h("p", { class: "desc" }, "The agent keeps short notes on this Mac in each conversation's MEMORY.md and only uses them in the conversation where they were learned. People can also say /memory or /forget in the chat."),
        h("div", { class: "form" }, h("label", {}, "Conversation"), h("div", { class: "inline" }, select, m.updatedAt ? h("span", { class: "meta" }, `updated ${relTime(m.updatedAt)}`) : null)),
      ),
      card(
        h("div", { class: "card-head" }, h("h3", {}, "Saved memory"), h("div", { class: "actions" }, h("span", { class: "pill" }, `${m.chars} characters`))),
        h("div", { style: "margin-top:8px" }, area),
        h("div", { class: "inline", style: "margin-top:10px" }, saveBtn, button("Revert", () => render()), h("span", { style: "flex:1" }), erase),
      ),
      card(
        h("div", { class: "card-head" }, h("h3", {}, "Conversation history"), h("div", { class: "actions" }, h("span", { class: m.hasSession ? "pill accent" : "pill" }, m.hasSession ? "In progress" : "Fresh"))),
        h("p", { class: "desc" }, "The agent continues one conversation per chat. Start fresh to drop the history. Memory is kept."),
        button("Start a fresh conversation", async () => {
          await api.resetSession(m.guid);
          toast("The next message starts a fresh conversation");
          render();
        }, { iconName: "restart" }),
      ),
    );
  };

  RENDER.automations = async () => {
    const [tasks, conv] = await Promise.all([api.automations(), api.conversations()]);
    const active = tasks.filter((t) => t.enabled);
    const conditionText = {
      fantasy_week_final: "When every NFL game of the week is final",
      fantasy_scoring_swing: "When the projected score swings during games",
    };
    const rows = tasks.map((t) => {
      let confirm = false;
      const del = h("button", { class: "icon-btn", title: "Delete", "aria-label": `Delete ${t.description}` }, icon("trash", 15));
      del.addEventListener("click", async () => {
        if (!confirm) {
          confirm = true;
          del.replaceWith(delConfirm);
          setTimeout(() => delConfirm.isConnected && delConfirm.replaceWith(del), 3500);
          return;
        }
      });
      const edit = h("button", { class: "icon-btn", title: "Edit", "aria-label": `Edit ${t.description}` }, icon("pencil", 15));
      edit.addEventListener("click", () => {
        state.editAutomation = state.editAutomation === t.id ? null : t.id;
        state.newAutomation = false;
        render();
      });
      const delConfirm = button("Delete", async () => {
        await api.deleteAutomation(t.id);
        toast("Automation deleted");
        render();
      }, { danger: true });
      const row = h(
        "div",
        { class: "row" },
        h("span", { class: "avatar" }, icon("calendar", 16)),
        h(
          "div",
          { class: "grow" },
          h("div", { class: "title" }, t.description),
          h("div", { class: "sub" }, [t.scheduleText, t.chatLabel].join(" · ")),
          t.condition ? h("div", { class: "sub" }, `Only ${conditionText[t.condition] ? conditionText[t.condition].toLowerCase() : t.condition}`) : null,
        ),
        h("span", { class: "meta" }, t.enabled && t.nextRun ? `Next ${stamp(t.nextRun)}` : "Off"),
        toggle(t.enabled, async (on) => {
          await api.setAutomationEnabled(t.id, on);
          toast(on ? "Automation on" : "Automation off");
          render();
        }, `${t.description} on`),
        edit,
        del,
      );
      return state.editAutomation === t.id ? [row, automationForm(conv, t)] : row;
    });

    return h(
      "div",
      { class: "page" },
      pageHead("Automations", "Schedule recurring work for your agent."),
      card(
        h(
          "div",
          { class: "card-head" },
          h("h3", {}, "Your automations"),
          h("div", { class: "actions" }, button("New automation", () => {
            state.newAutomation = !state.newAutomation;
            state.editAutomation = null;
            render();
          }, { iconName: "plus" })),
        ),
        h("p", { class: "desc" }, "Run an agent instruction on a schedule. The result is sent to the conversation. People can also ask the agent in Messages to set these up."),
        state.newAutomation ? automationForm(conv) : null,
        h("p", { class: "meta", style: "margin:4px 0 0" }, `${active.length} active${tasks.length > active.length ? `, ${tasks.length - active.length} off` : ""}`),
        rows.length ? h("div", { class: "rows", style: "margin-top:6px;border-top:1px solid var(--divider)" }, rows) : h("div", { class: "empty" }, icon("calendar", 18), "No automations yet"),
      ),
    );
  };

  /** Form for a new automation, or for editing `existing` (an item from api.automations()). */
  function automationForm(conv, existing = null) {
    const targets = [
      ...conv.direct.filter((d) => d.allowed && d.guid).map((d) => ({ guid: d.guid, label: d.name ? `${d.name} (${d.handle})` : d.handle })),
      ...conv.groups.filter((g) => g.allowed).map((g) => ({ guid: g.guid, label: g.name || "Group chat" })),
    ];
    // Keep an automation's current chat selectable even if it's no longer allowed.
    if (existing && !targets.some((t) => t.guid === existing.chatGuid)) targets.push({ guid: existing.chatGuid, label: `${existing.chatLabel} (not allowed)` });
    const to = h("select", {}, targets.map((t) => h("option", { value: t.guid }, t.label)));
    if (existing) to.value = existing.chatGuid;
    const name = h("input", { type: "text", placeholder: "e.g. Morning briefing", value: existing?.description ?? "" });
    const presets = [
      ["0 8 * * *", "Every day"],
      ["0 8 * * 1-5", "Weekdays"],
      ["0 9 * * 1", "Mondays"],
      ["0 12 * * 2", "Tuesdays"],
      ["0 12 * * 4", "Thursdays"],
      ["custom", "Custom…"],
    ];
    const preset = h("select", {}, presets.map(([v, l]) => h("option", { value: v }, l)));
    const time = h("input", { type: "text", value: "08:00", style: "width:80px;flex:none", "aria-label": "Time (24h)" });
    const cron = h("input", { type: "text", class: "mono", placeholder: "cron (min hour day month weekday) or 2026-10-01T09:30", style: "display:none;width:300px;flex:none" });
    // Show an existing schedule as a preset + time when it fits one, else as custom.
    if (existing) {
      const f = existing.schedule.trim().split(/\s+/);
      const match = f.length === 5 && /^\d+$/.test(f[0]) && /^\d+$/.test(f[1]) && presets.find(([v]) => v !== "custom" && v.split(" ").slice(2).join(" ") === f.slice(2).join(" "));
      if (match) {
        preset.value = match[0];
        time.value = `${f[1].padStart(2, "0")}:${f[0].padStart(2, "0")}`;
      } else {
        preset.value = "custom";
        cron.value = existing.schedule;
      }
    }
    const preview = h("span", { class: "meta" });
    const schedule = () => {
      if (preset.value === "custom") return cron.value.trim();
      const [hh, mm] = time.value.split(":").map(Number);
      const f = preset.value.split(" ");
      return `${Number.isFinite(mm) ? mm : 0} ${Number.isFinite(hh) ? hh : 8} ${f.slice(2).join(" ")}`;
    };
    const update = async () => {
      const custom = preset.value === "custom";
      cron.style.display = custom ? "" : "none";
      time.style.display = custom ? "none" : "";
      const sched = schedule();
      preview.textContent = sched ? await api.describeSchedule(sched).catch(() => "") : "";
    };
    for (const el of [preset, time, cron]) el.addEventListener("input", update);
    const condition = h("select", {},
      h("option", { value: "" }, "Every time it's scheduled"),
      h("option", { value: "fantasy_week_final" }, "Only once every NFL game of the week is final"),
      h("option", { value: "fantasy_scoring_swing" }, "Only when live scoring swings past the alert threshold"));
    condition.value = existing?.condition ?? "";
    const prompt = h("textarea", { rows: 4, placeholder: 'What should the agent do? e.g. "Send me the weather and my calendar for today."' });
    prompt.value = existing?.prompt ?? "";
    void update();
    const close = () => {
      state.newAutomation = false;
      state.editAutomation = null;
      render();
    };
    if (!targets.length) return h("div", { class: "banner warn", style: "margin:8px 0" }, icon("alert", 18), "Allow a conversation first, so the automation has somewhere to post.");
    const fields = { get chatGuid() { return to.value; }, get description() { return name.value; }, get schedule() { return schedule(); }, get prompt() { return prompt.value; }, get condition() { return condition.value || null; } };
    const values = () => ({ chatGuid: fields.chatGuid, description: fields.description, schedule: fields.schedule, prompt: fields.prompt, condition: fields.condition });
    return h(
      "div",
      { class: "form", style: `padding:12px 0 14px${existing ? ";border-top:1px solid var(--divider)" : ""}` },
      h("label", {}, "Send to"), to,
      h("label", {}, "Name"), name,
      h("label", {}, "Schedule"), h("div", { class: "inline" }, preset, time, cron, preview),
      h("label", {}, "Run"), condition,
      h("label", { style: "align-self:start;margin-top:6px" }, "Instruction"), prompt,
      h("span"),
      h(
        "div",
        { class: "inline" },
        existing
          ? button("Save changes", async () => {
              await api.updateAutomation(existing.id, values());
              toast("Automation updated");
              close();
            }, { primary: true })
          : button("Create automation", async () => {
              await api.createAutomation(values());
              toast("Automation created");
              close();
            }, { primary: true }),
        button("Cancel", close),
        existing && !existing.enabled ? h("span", { class: "meta" }, "This automation is off. Turn it on from the list after saving.") : null,
      ),
    );
  }

  RENDER.logs = async () => {
    const lg = await api.logs();
    const filters = { all: () => true, replies: (e) => e.kind === "reply" || e.kind === "turn", issues: (e) => e.kind === "error" || e.kind === "ignored" };
    const events = lg.events.filter(filters[state.logFilter]);
    const per = 20;
    const pages = Math.max(1, Math.ceil(events.length / per));
    state.logPage = Math.min(state.logPage, pages - 1);
    const slice = events.slice(state.logPage * per, state.logPage * per + per);
    const seg = h(
      "div",
      { class: "segmented" },
      Object.keys(filters).map((f) =>
        h("button", { class: state.logFilter === f ? "on" : "", onclick: () => ((state.logFilter = f), (state.logPage = 0), render()) }, f[0].toUpperCase() + f.slice(1)),
      ),
    );
    const go = (d) => () => {
      state.logPage += d;
      render();
    };
    return h(
      "div",
      { class: "page" },
      pageHead("Logs", "Recent agent activity and support information.", button("Open logs folder", () => api.open("logs"), { iconName: "folder" })),
      card(
        h("div", { class: "card-head" }, h("h3", {}, "Recent activity"), h("div", { class: "actions" }, seg)),
        slice.length
          ? h(
              "div",
              { class: "rows", style: "margin-top:6px" },
              slice.map((e) =>
                h(
                  "div",
                  { class: "row log-row" },
                  h("span", { class: `dot ${e.kind}` }),
                  h("div", { class: "grow" }, h("div", { class: "title" }, e.title), h("div", { class: "sub selectable" }, e.detail)),
                  e.link ? linkTo(e.link.to, e.link.label, "settings") : null,
                  h("span", { class: "meta" }, stamp(e.at)),
                ),
              ),
            )
          : h("div", { class: "empty" }, icon("logs", 18), "Nothing here yet."),
        events.length
          ? h(
              "div",
              { class: "pager" },
              h("span", { class: "grow" }, `${state.logPage * per + 1}–${state.logPage * per + slice.length} of ${events.length} recent events`),
              h("button", { class: "icon-btn", disabled: state.logPage === 0, onclick: go(-1), "aria-label": "Previous page" }, "‹"),
              `Page ${state.logPage + 1} of ${pages}`,
              h("button", { class: "icon-btn", disabled: state.logPage >= pages - 1, onclick: go(1), "aria-label": "Next page" }, "›"),
            )
          : null,
      ),
      lg.errors.length ? card(h("h3", {}, "Error output"), h("p", { class: "desc" }, "The last lines the agent wrote to agent.err.log."), h("pre", { class: "errors" }, lg.errors.slice(-25).join("\n"))) : null,
    );
  };

  RENDER.settings = async () => {
    const { TABS, parseRoute } = SETTINGS_TABS;
    const tab = parseRoute(location.hash).tab;
    // The sidebar's Settings link reopens the last tab this session; plain #settings links open General.
    $('#nav a[data-page="settings"]').setAttribute("href", `#settings/${tab}`);
    const [s, teams, plan] = await Promise.all([
      api.settings(),
      tab === "fantasy" ? api.fantasyTeams().catch(() => []) : [],
      tab === "alerts" ? api.alertPlan().catch(() => []) : [],
    ]);
    const save = async (patch, msg) => {
      await api.saveSettings(patch);
      saved(msg);
      await refreshOverview();
      const b = restartBanner();
      const old = document.querySelector(".page > .banner");
      if (old) old.replaceWith(b ?? document.createComment(""));
      else if (b) document.querySelector(".page-head").after(b);
    };
    // Every control carries data-setting=<key>, so a capture can check that each setting is on its tab.
    const tagged = (el, key) => ((el.dataset.setting = key), el);
    const textSetting = (key, value, attrs = {}, after) => {
      const input = tagged(h("input", { type: "text", value, ...attrs }), key);
      const b = button("Save", async () => {
        await save({ [key]: input.value });
        b.disabled = true;
        value = input.value;
        after?.();
      });
      b.disabled = true;
      input.addEventListener("input", () => (b.disabled = input.value === String(value)));
      input.addEventListener("keydown", (e) => e.key === "Enter" && !b.disabled && b.click());
      return h("div", { class: "inline" }, input, b);
    };
    // A number with a unit suffix ("5 %"), saved on Enter or the Save button.
    const numSetting = (key, value, unit, attrs = {}) => {
      let saved0 = String(value);
      const input = tagged(h("input", { type: "text", value: saved0, style: "max-width:70px", ...attrs }), key);
      const b = button("Save", async () => {
        await save({ [key]: Number(input.value) });
        saved0 = input.value;
        b.disabled = true;
      });
      b.disabled = true;
      const ok = () => input.value.trim() !== "" && Number.isFinite(Number(input.value));
      input.addEventListener("input", () => (b.disabled = input.value === saved0 || !ok()));
      input.addEventListener("keydown", (e) => e.key === "Enter" && !b.disabled && b.click());
      return h("div", { class: "inline" }, input, h("span", { class: "unit" }, unit), b);
    };
    // A labelled on/off setting: the toggle plus its one-line description.
    const toggleSetting = (key, on, label, text, after) =>
      h("span", { class: "toggle-label" }, tagged(toggle(on, async (v) => {
        await save({ [key]: v });
        after?.();
      }, label), key), text);
    const selectSetting = (key, options, value, attrs = {}, msg) => {
      const sel = tagged(h("select", attrs, options.map(([v, l]) => h("option", { value: v }, l))), key);
      if (value && !options.some(([v]) => v === value)) sel.append(h("option", { value }, value));
      sel.value = value ?? "";
      sel.addEventListener("change", () => save({ [key]: sel.value || null }, msg).catch((e) => toast(e.message, true)));
      return sel;
    };

    const panel = {
      general: () => {
        const models = [
          ["", "Claude Code default"],
          ["claude-opus-5-5", "Claude Opus 5.5"],
          ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
          ["claude-fable-5-1", "Claude Fable 5.1"],
          ["claude-haiku-4-5", "Claude Haiku 4.5"],
        ];
        // ChatGPT: the plan's models come from Codex's model list (known after the first reply).
        const g = s.chatgpt;
        const provider = tagged(h("select", { "aria-label": "Assistant" }, h("option", { value: "claude" }, "Claude"), h("option", { value: "chatgpt" }, "ChatGPT")), "provider");
        provider.value = s.provider;
        provider.addEventListener("change", async () => {
          try {
            await save({ provider: provider.value }, `Assistant set to ${provider.selectedOptions[0].text}`);
            render();
          } catch (e) {
            toast(e.message, true);
            provider.value = s.provider;
          }
        });
        const planLabel = (p) => ({ free: "Free", go: "Go", plus: "Plus", pro: "Pro", team: "Business", business: "Business", edu: "Edu", enterprise: "Enterprise" })[p] ?? p;
        const account = g.signedIn
          ? h("div", { class: "inline" },
              h("span", { class: "toggle-label" }, icon("check", 16), `Signed in${g.plan ? ` · ${planLabel(g.plan)} plan` : ""}`),
              button("Sign out", async () => {
                await api.chatgptSignOut();
                toast("Signed out of ChatGPT");
                render();
              }))
          : h("div", { class: "inline" },
              h("span", { class: "toggle-label", style: "color:var(--warn)" }, icon("alert", 16), "Not signed in"),
              button("Sign in with ChatGPT", async (b) => {
                b.textContent = "Finish signing in in your browser…";
                try {
                  const acct = await api.chatgptSignIn();
                  toast(`Signed in to ChatGPT${acct.plan ? ` (${planLabel(acct.plan)} plan)` : ""}`);
                } finally {
                  render();
                }
              }, { primary: true }));
        const assistantRows =
          s.provider === "chatgpt"
            ? [
                h("label", {}, "ChatGPT account"), account,
                h("div", { class: "hint" }, "Opens your browser. Waterboy keeps its own ChatGPT sign-in, separate from the ChatGPT and Codex apps. Replies count toward your ChatGPT plan's limits; Free and Go have the smallest, and busy group chats can run into them."),
                h("label", {}, "Model"), selectSetting("chatgpt.model", [["", "ChatGPT plan default"], ...g.models.map((m) => [m.id, m.name])], g.model, {}, "Model saved"),
                h("div", { class: "hint" }, g.models.length ? "Models available on your ChatGPT plan." : "More models appear here after the first reply."),
              ]
            : [h("label", {}, "Model"), selectSetting("model", models, s.model, {}, "Model saved"), h("div", { class: "hint" }, "Uses your Claude Code sign-in.")];
        return [
          card(
            h("h3", {}, "Assistant"),
            h("div", { class: "form" },
              h("label", {}, "Name"), textSetting("agentName", s.agentName),
              h("div", { class: "hint" }, "What the agent calls itself in replies."),
              h("label", {}, "Assistant"), provider,
              h("div", { class: "hint" }, "Who writes the replies. Switching starts fresh conversations (memory is kept). Changes apply after a restart."),
              ...assistantRows,
            ),
          ),
          // One release of pointing the way: Google Calendar used to be on this page.
          h("p", { class: "note", style: "margin:0 4px" }, "Google Calendar access is now under ", h("button", { class: "link", onclick: () => (location.hash = "#connections") }, "Connections"), "."),
        ];
      },
      conversations: () => [
        card(
          h("h3", {}, "Group chats"),
          h("div", { class: "form" },
            h("label", {}, "Wake words"), textSetting("groupTriggers", s.groupTriggers.join(", ")),
            h("div", { class: "hint" }, "Comma-separated. The agent replies in groups when a message contains one of these."),
            h("label", {}, "Reply to everything"), toggleSetting("respondToAllInGroups", s.respondToAllInGroups, "Reply to every group message", "Answer every group message, not only mentions"),
          ),
        ),
        card(
          h("h3", {}, "Messages"),
          h("div", { class: "form" },
            h("label", {}, "Transcribe"), toggleSetting("voice.enabled", s.voice.enabled, "Transcribe voice messages", "Transcribe incoming voice messages on this Mac"),
            h("div", { class: "hint" }, "Uses whisper.cpp locally. Nothing is uploaded."),
            h("label", {}, "Typing indicator"), toggleSetting("typingIndicators", s.typingIndicators, "Typing indicator", "Show “typing…” in the chat while a reply is being written"),
            h("div", { class: "hint" }, "Needs Accessibility access for Waterboy (System Settings → Privacy & Security → Accessibility). Uses a hidden second copy of Messages; one chat shows typing at a time."),
            h("label", {}, "Threaded replies"),
            selectSetting("threadedReplies", [["auto", "When the chat has moved on"], ["always", "Always"], ["off", "Never"]], s.threadedReplies, { "aria-label": "Threaded replies in group chats" }, "Threaded replies saved"),
            h("div", { class: "hint" }, "In group chats, answer as a reply to the message that asked, so it's clear who it's for. Messages that only need a thumbs-up or a laugh get a tapback instead of a text. Both use the same helper and Accessibility access as the typing indicator."),
          ),
        ),
      ],
      fantasy: () => {
        const f = s.fantasy;
        if (!f) return [noLeague()];
        const mine = selectSetting("fantasy.myTeamId", [["", "Not set"], ...teams.map((t) => [String(t.id), t.name])], f.myTeamId == null ? "" : String(f.myTeamId), { "aria-label": "Default team" });
        return [
          card(
            h("h3", {}, "League"),
            h("div", { class: "form" },
              h("label", {}, "ESPN league ID"), textSetting("fantasy.espnLeagueId", f.espnLeagueId, { class: "mono", style: "max-width:200px" }, () => render()),
              h("label", {}, "Default team"), mine,
              h("div", { class: "hint" }, 'Used for "my team" when the person asking has no team set in Conversations.'),
              h("label", {}, "Dynasty league"), toggleSetting("fantasy.dynasty", f.dynasty, "Dynasty league", "Value players for future seasons too (trade values)"),
            ),
          ),
          card(
            h("h3", {}, "Data sources"),
            h("div", { class: "form" },
              h("label", {}, "Sleeper data"), toggleSetting("fantasy.sleeper", f.sleeper, "Sleeper data", "Second-opinion projections and trending players"),
              h("label", {}, "NFL usage stats"), toggleSetting("fantasy.nflverse", f.nflverse, "NFL usage stats", "Snap %, targets, expected points and injury reports from nflverse"),
              h("div", { class: "hint" },
                f.nflverseUpdatedAt
                  ? `Downloaded from GitHub about once a day. Last updated ${relTime(f.nflverseUpdatedAt)}.`
                  : f.nflverse ? "Downloads from GitHub about once a day, starting the next time the agent starts." : "Off. The agent won't download or use nflverse data."),
              h("label", {}, "Betting lines"), toggleSetting("fantasy.vegas", f.vegas, "Betting lines", "Spreads, implied team points and weather in previews and answers"),
              h("label", {}, "Expert rankings"), toggleSetting("fantasy.rankings", f.rankings, "Expert rankings", "FantasyPros consensus rankings for start/sit questions"),
              h("label", {}, "Trade values"), toggleSetting("fantasy.tradeValues", f.tradeValues, "Trade values", "FantasyCalc values for \"is this trade fair?\""),
            ),
          ),
          card(
            h("h3", {}, "Image cards"),
            h("div", { class: "form" },
              h("label", {}, "Start/sit cards"), toggleSetting("fantasy.startSitCards", f.startSitCards, "Start/sit cards", "Send a comparison image with “who should I start?” answers"),
              h("label", {}, "Trade cards"), toggleSetting("fantasy.tradeCards", f.tradeCards, "Trade cards", "Send a trade analysis image with trade evaluations"),
              h("label", {}, "Comparison cards"), toggleSetting("fantasy.compareCards", f.compareCards, "Comparison cards", "Send a season comparison image when comparing two players"),
            ),
          ),
        ];
      },
      alerts: () => (s.fantasy ? [liveAlertsCard(s.fantasy.liveAlerts, plan, save, numSetting, tagged)] : [noLeague()]),
      advanced: () => [
        card(
          h("h3", {}, "Limits and safety"),
          h("div", { class: "form" },
            h("label", {}, "Max steps per reply"), textSetting("maxTurns", String(s.maxTurns), { style: "max-width:90px" }),
            s.provider === "chatgpt" ? h("div", { class: "hint" }, "Claude only. ChatGPT replies are limited by the reply timeout.") : null,
            h("label", {}, "Reply timeout (min)"), (() => {
              let minutes = String(Math.round(s.turnTimeoutMs / 60000));
              const input = tagged(h("input", { type: "text", value: minutes, style: "max-width:90px" }), "turnTimeoutMs");
              const b = button("Save", async () => {
                await save({ turnTimeoutMs: Number(input.value) * 60000 });
                minutes = input.value;
                b.disabled = true;
              });
              b.disabled = true;
              input.addEventListener("input", () => (b.disabled = input.value === minutes || !(Number(input.value) > 0)));
              input.addEventListener("keydown", (e) => e.key === "Enter" && !b.disabled && b.click());
              return h("div", { class: "inline" }, input, b);
            })(),
            // Re-render so the tab's warning follows the switch.
            h("label", {}, "Shell commands"), toggleSetting("allowBash", s.allowBash, "Allow shell commands", "Let the agent run commands on this Mac", () => render()),
            h("div", { class: "hint", style: s.allowBash ? "color:var(--warn)" : "" },
              s.provider === "chatgpt"
                ? "Anyone in an allowed 1:1 conversation could then run commands here. With ChatGPT they run in a sandbox that can read this Mac but only write to the chat folder, without network access. Leave off unless you need it."
                : "Anyone in an allowed 1:1 conversation could then run commands here. Leave off unless you need it."),
          ),
        ),
        card(
          h("h3", {}, "Usage"),
          h("div", { class: "form" },
            h("label", {}, "Daily cost alert"), (() => {
              let value = s.usage.dailyCostAlertUsd === null ? "" : String(s.usage.dailyCostAlertUsd);
              const input = tagged(h("input", { type: "text", value, placeholder: "Off", style: "max-width:80px", "aria-label": "Daily cost alert in dollars" }), "usage.dailyCostAlertUsd");
              const ok = () => input.value.trim() === "" || Number(input.value.trim().replace(/^\$/, "")) >= 0;
              const b = button("Save", async () => {
                const off = input.value.trim() === "";
                await save({ "usage.dailyCostAlertUsd": input.value }, off ? "Daily cost alert off" : "Daily cost alert saved");
                value = input.value = off ? "" : String(Math.round(Number(input.value.trim().replace(/^\$/, "")) * 100) / 100);
                b.disabled = true;
              });
              b.disabled = true;
              input.addEventListener("input", () => (b.disabled = input.value === value || !ok()));
              input.addEventListener("keydown", (e) => e.key === "Enter" && !b.disabled && b.click());
              return h("div", { class: "inline" }, h("span", { class: "unit", style: "margin:0" }, "Warn me above $"), input, h("span", { class: "unit" }, "per day"), b);
            })(),
            h("div", { class: "hint" },
              s.provider === "chatgpt"
                ? "Claude only. ChatGPT doesn't report a cost per reply, so this never fires with ChatGPT."
                : "Leave empty for off. When a day's API-equivalent cost goes over this, the Dashboard shows a warning once that day and the log notes it. Nothing is texted."),
          ),
        ),
      ],
    };

    // Fantasy and Live alerts without a league: say so and offer the setup step, rather than an empty tab.
    function noLeague() {
      return card(
        h("h3", {}, "No fantasy league yet"),
        h("p", { class: "desc" }, "Connect your ESPN league to get start/sit, trade and matchup answers, image cards and live scoring alerts."),
        button("Set up your league", () => {
          setupStep(3);
          location.hash = "#setup";
        }, { primary: true }),
      );
    }

    // Tabs: a ⚠ on Advanced while shell commands are on, a dot on Fantasy while there's no league.
    const flag = (id) =>
      id === "advanced" && s.allowBash
        ? h("span", { class: "tab-flag bad-icon", role: "img", "aria-label": "Shell commands are on", title: "Shell commands are on" }, icon("alert", 12))
        : id === "fantasy" && !s.fantasy?.espnLeagueId
          ? h("span", { class: "tab-dot", role: "img", "aria-label": "No league set", title: "No league set" })
          : null;
    const goTab = (id) => {
      if (id !== tab) location.hash = `#settings/${id}`;
    };
    const tabs = h("div", { class: "segmented tabs", role: "tablist", "aria-label": "Settings sections" },
      TABS.map((t) =>
        h("button", {
          role: "tab",
          id: `settings-tab-${t.id}`,
          class: t.id === tab ? "on" : "",
          "aria-selected": t.id === tab ? "true" : "false",
          "aria-controls": "settings-panel",
          tabindex: t.id === tab ? "0" : "-1",
          onclick: () => goTab(t.id),
        }, t.label, flag(t.id))));
    // Arrow keys, Home and End move between tabs (and open them), keeping focus on the tab bar.
    tabs.addEventListener("keydown", (e) => {
      const i = TABS.findIndex((t) => t.id === tab);
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      state.focusSettingsTab = true;
      goTab(TABS[(to + TABS.length) % TABS.length].id);
    });
    if (state.focusSettingsTab) {
      state.focusSettingsTab = false;
      setTimeout(() => $(`#settings-tab-${tab}`)?.focus());
    }

    return h(
      "div",
      { class: "page" },
      pageHead("Settings", "Choose how the agent behaves on this Mac."),
      restartBanner(),
      tabs,
      h("div", { class: "tabpanel", role: "tabpanel", id: "settings-panel", "aria-labelledby": `settings-tab-${tab}` }, panel[tab]()),
    );
  };

  /** Google Calendar access (claude.ai connector tools in extraAllowedTools); on the Connections page. */
  function calendarCard(s) {
    const level = h("select", { "aria-label": "Google Calendar access" },
      h("option", { value: "off" }, "Off"),
      h("option", { value: "read" }, "Read only"),
      h("option", { value: "full" }, "Read and edit"));
    level.value = s.connectors.googleCalendar;
    level.disabled = s.provider === "chatgpt";
    const hint = h("div", { class: "hint" });
    const describe = () => {
      if (s.provider === "chatgpt") return (hint.textContent = "");
      hint.textContent = {
        off: "The agent can't see your calendar.",
        read: "The agent can check your schedule, find events and suggest free times.",
        full: "The agent can also create, change and delete events and respond to invites. Anyone with Everything access can ask it to.",
      }[level.value];
      hint.style.color = level.value === "full" ? "var(--warn)" : "";
    };
    describe();
    level.addEventListener("change", async () => {
      try {
        await api.setConnector("googleCalendar", level.value);
        describe();
        saved(`Google Calendar: ${level.selectedOptions[0].text.toLowerCase()}`);
        await refreshOverview();
        render(); // the extra allowed tools below change with it
      } catch (e) {
        toast(e.message, true);
      }
    });
    return card(
      h("h3", {}, "Google Calendar"),
      h("div", { class: "form" },
        h("label", {}, "Access"), level, hint,
        h("p", { class: "note full", style: "margin:0" },
          s.provider === "chatgpt"
            ? "Only available with Claude as the assistant: it uses the Google Calendar connector on your Claude account."
            : "Uses the Google Calendar connector on your Claude account (claude.ai → Settings → Connectors) and only works in 1:1 chats with Everything access. Group chats and fantasy-only people never get it."),
      ),
    );
  }

  /**
   * Live scoring alerts (fantasy.liveAlerts in the service config). Only people with a fantasy
   * team can subscribe: the alert watches their own matchup, so without a team there is nothing
   * to watch. Everything below the master toggle is disabled while alerts are off.
   */
  function liveAlertsCard(a, plan, save, numSetting, tagged) {
    // Subscribing is only half of it: each person also needs an automation in their own chat,
    // which is what actually runs the check. Flag anyone subscribed without one.
    const byHandle = new Map(plan.map((p) => [p.handle, p]));
    const missing = plan.filter((p) => !p.hasAutomation && p.guid && p.allowed);
    const unreachable = plan.filter((p) => !p.guid || !p.allowed);
    const statusFor = (handle) => {
      const p = byHandle.get(handle);
      if (!p) return null;
      if (p.hasAutomation) return h("span", { class: "pill ok" }, "scheduled");
      if (!p.guid || !p.allowed) return h("span", { class: "pill warn" }, "no conversation");
      return h("span", { class: "pill" }, "not scheduled");
    };
    const rows = [];
    let createBtn;
    const everyone = toggle(a.everyone, async (on) => {
      await api.setAlertSubscriber("*", on);
      saved(on ? "Everyone with a team gets live alerts" : "Live alerts are now per person");
      render();
    }, "Everyone with a team");
    rows.push(
      h("label", {}, "Who gets alerts"),
      h("span", { class: "toggle-label" }, everyone, "Everyone with a fantasy team"),
    );
    if (!a.everyone) {
      rows.push(
        h("div", { class: "hint" }, a.people.length ? "Or pick people one at a time:" : "Nobody has a fantasy team yet \u2014 set teams in Conversations first."),
      );
      for (const p of a.people) {
        const label = p.name ?? p.handle;
        rows.push(
          h("label", { class: "sub" }, label),
          h("span", { class: "toggle-label" },
            toggle(p.subscribed, async (on) => {
              await api.setAlertSubscriber(p.handle, on);
              saved(on ? `${label} will get live alerts` : `${label} won't get live alerts`);
              render();
            }, `Live alerts for ${label}`),
            p.team,
            statusFor(p.handle)),
        );
      }
    }
    const body = h("div", { class: `form${a.enabled ? "" : " disabled"}` },
      h("label", {}, "Alert threshold"), numSetting("fantasy.liveAlerts.thresholdPct", a.thresholdPct, "%"),
      h("div", { class: "hint" }, "How far a team's projected final has to move since the last check before anyone is texted. Smaller means more messages."),
      h("label", {}, "Check every"), numSetting("fantasy.liveAlerts.checkMinutes", a.checkMinutes, "min"),
      h("div", { class: "hint" }, "Only while NFL games are being played. Between games nothing is fetched and nothing is sent."),
      h("label", {}, "List players moving"), numSetting("fantasy.liveAlerts.minPlayerPoints", a.minPlayerPoints, "pts"),
      h("div", { class: "hint" }, "Smallest per-player change worth naming in the alert."),
      ...rows,
      h("span"),
      h("div", { class: "inline", style: "margin-top:4px" },
        createBtn = button(missing.length > 1 ? `Create ${missing.length} alert automations` : "Create alert automation", async () => {
          const r = await api.createAlertAutomations();
          toast(r.created.length ? `Scheduled live alerts for ${r.created.join(", ")}` : r.skipped.join("; ") || "Nothing to create");
          render();
        }, { primary: true, iconName: "calendar" }),
      ),
      h("div", { class: "hint" },
        !plan.length
          ? "Turn someone on above first, then create the automation that runs their check."
          : missing.length
            ? `Adds a check every ${a.checkMinutes} min on Sun/Mon/Thu to ${missing.length === 1 ? "this person's" : "each person's"} conversation. It shows up under Automations, where you can pause or delete it.`
            : unreachable.length
              ? "Everyone reachable is scheduled. The rest need an allowed 1:1 conversation first (see Conversations)."
              : "Everyone subscribed is scheduled. Manage or pause these under Automations."),
    );
    if (!missing.length) createBtn.disabled = true; // nothing to add
    if (!a.enabled) for (const el of body.querySelectorAll("input, select, button")) el.disabled = true;
    return card(
      h("div", { class: "card-head" },
        h("h3", {}, "Live scoring alerts"),
        h("span", { class: "toggle-label" }, tagged(toggle(a.enabled, async (on) => {
          await save({ "fantasy.liveAlerts.enabled": on });
          render();
        }, "Live scoring alerts"), "fantasy.liveAlerts.enabled"), a.enabled ? "On" : "Off"),
      ),
      h("p", { class: "desc" }, "While games are being played, Waterboy watches each subscriber's matchup and texts them when the projected score swings. The message is written by Waterboy itself, so it costs nothing per alert."),
      body,
    );
  }

  // ---------- first-run setup ----------

  const SETUP_STEPS = ["Permissions", "Sign in", "Conversations", "Fantasy league", "Done"];
  const setupDone = () => {
    try {
      return !!localStorage.getItem("setupDone");
    } catch {
      return false;
    }
  };
  // The step survives quitting the app, which granting Full Disk Access often takes.
  const setupStep = (n) => {
    try {
      if (n === undefined) return Number(localStorage.getItem("setupStep")) || 0;
      localStorage.setItem("setupStep", String(n));
    } catch {}
    return n ?? 0;
  };
  const finishSetup = () => {
    try {
      localStorage.setItem("setupDone", "1");
      localStorage.removeItem("setupStep");
    } catch {}
    location.hash = "#dashboard";
  };
  /** First launch and the basics aren't in place yet: open setup instead of the Dashboard. */
  const needsSetup = (o) => !setupDone() && !!o && !(o.readiness.claude.ok && o.readiness.messages.ok && o.readiness.conversations.ok);

  RENDER.setup = async () => {
    const o = state.overview;
    if (!o) throw new Error("Couldn't reach the agent.");
    const r = o.readiness;
    const s = o.status;
    const name = o.agentName;
    const step = Math.min(setupStep(), SETUP_STEPS.length - 1);
    const go = (n) => {
      setupStep(n);
      $("#content").scrollTop = 0;
      render();
    };

    // A status line: check when done, orange alert when required, grey when optional or unknown.
    const status = (c, { optional = false, unknown = "Not checked yet" } = {}) =>
      h("span", { class: "setup-status" },
        h("span", { class: c?.ok ? "ok-icon" : c && !optional ? "bad-icon" : "muted-icon" }, icon(c?.ok ? "check" : "alert", 16)),
        c?.detail ?? unknown);
    const row = (title, detail, st, action) =>
      h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "title" }, title), h("div", { class: "sub" }, detail)), st, action ?? null);
    const pane = (which) => button("Open System Settings", () => api.openPrivacy(which), { iconName: "external" });
    const nav = ({ next = "Continue", skip = false, extra = null } = {}) =>
      h("div", { class: "setup-nav" },
        step > 0 ? button("Back", () => go(step - 1)) : h("span"),
        h("div", { class: "inline" },
          extra,
          skip ? h("button", { class: "link", onclick: () => go(step + 1) }, "Skip for now") : null,
          button(next, () => go(step + 1), { primary: true })));

    const stepper = h("ol", { class: "stepper" },
      SETUP_STEPS.map((t, i) =>
        h("li", { class: i === step ? "active" : i < step ? "done" : "" },
          h("span", { class: "num" }, i < step ? icon("check", 12) : String(i + 1)), t)));

    // Steps after Permissions read config.json, which exists once the service is set up.
    const noConfig = (e) => [
      card(h("div", { class: "empty" }, icon("alert", 18), e.message)),
      h("div", { class: "setup-nav" }, button("Back to Permissions", () => go(0)), h("button", { class: "link", onclick: () => go(step + 1) }, "Skip this step")),
    ];

    let body;
    if (step === 0) {
      // The permissions belong to the service, so it has to be installed and running to check them.
      const setup = o.setup ?? {};
      const svc = s.running ? { ok: true, detail: "Running" } : { ok: false, detail: s.installed ? "Paused" : "Not installed" };
      const svcAction = !s.installed
        ? setup.bundled && setup.state !== "blocked"
          ? button("Install service", async () => {
              await api.installService();
              toast("Service installed");
              render();
            }, { primary: true })
          : null
        : !s.running
          ? button(`Start ${name}`, async () => {
              await api.start();
              render();
            }, { primary: true })
          : null;
      body = [
        card(
          h("h3", {}, "Give Waterboy access"),
          h("p", { class: "desc" }, `The Waterboy service reads and sends iMessages on this Mac. In each list, turn on Waterboy. Running the service from source? Add the node binary that npm run install-service printed instead.`),
          h("div", { class: "rows" },
            row("Service", !s.installed && !setup.bundled ? "Run npm run install-service in the agent project." : "Runs in the background and starts at login.", status(svc), svcAction),
            row("Full Disk Access", "Lets the service read new messages from the Messages database.", status(r.messages), r.messages.ok ? null : pane("fullDiskAccess")),
            row("Automation → Messages", "Lets the service send replies. macOS asks the first time; if you chose Don't Allow, turn it on here.",
              status(r.automation, { unknown: s.running ? "Checking…" : "Checked once the service runs" }), r.automation?.ok ? null : pane("automation")),
            row("Accessibility (optional)", "Shows “typing…” in a chat while a reply is on its way. Logs shows a note if it's missing.",
              status({ ok: false, detail: "Optional" }, { optional: true }), pane("accessibility")),
          ),
          h("p", { class: "note" }, "macOS applies Full Disk Access when the service restarts. Changes can take a minute to show here."),
        ),
        nav({ extra: button("Check again", () => render(true), { iconName: "refresh" }) }),
      ];
    } else if (step === 1) {
      const st = await api.settings().catch((e) => e);
      if (st instanceof Error) return page(noConfig(st));
      const provider = h("select", { "aria-label": "Assistant" }, h("option", { value: "claude" }, "Claude"), h("option", { value: "chatgpt" }, "ChatGPT"));
      provider.value = st.provider;
      provider.addEventListener("change", async () => {
        try {
          await api.saveSettings({ provider: provider.value });
          render();
        } catch (e) {
          toast(e.message, true);
          provider.value = st.provider;
        }
      });
      const how =
        st.provider === "chatgpt"
          ? st.chatgpt.signedIn
            ? null
            : button("Sign in with ChatGPT", async (b) => {
                b.textContent = "Finish signing in in your browser…";
                try {
                  await api.chatgptSignIn();
                  toast("Signed in to ChatGPT");
                } finally {
                  render();
                }
              }, { primary: true })
          : null;
      body = [
        card(
          h("h3", {}, "Choose an assistant and sign in"),
          h("div", { class: "form" },
            h("label", {}, "Assistant"), provider,
            h("label", {}, "Account"), h("div", { class: "inline" }, status(r.claude), how),
            st.provider === "chatgpt"
              ? h("div", { class: "hint" }, "Opens your browser. Waterboy keeps its own ChatGPT sign-in, separate from the ChatGPT and Codex apps.")
              : h("div", { class: "hint" },
                  "Waterboy uses Claude Code's sign-in on this Mac. Open Terminal, run ", h("code", {}, "claude"), " and sign in with ", h("code", {}, "/login"),
                  ". To use a long-lived token instead, run ", h("code", {}, "claude setup-token"), " and add ", h("code", {}, "CLAUDE_CODE_OAUTH_TOKEN=…"),
                  " to ", h("code", {}, "~/.imessage-agent/env"), ". Then check again."),
          ),
        ),
        nav({ extra: r.claude.ok ? null : button("Check again", () => render(true), { iconName: "refresh" }) }),
      ];
    } else if (step === 2) {
      const conv = await api.conversations().catch((e) => e);
      if (conv instanceof Error) return page(noConfig(conv));
      const recent = [
        ...conv.direct.map((d) => ({ key: d.handle, label: d.name || d.handle, sub: d.name ? d.handle : "", allowed: d.allowed, at: d.lastMessageAt, group: false })),
        ...conv.groups.map((g) => ({ key: g.name || g.guid, label: g.name || "Unnamed group", sub: g.members.map((m) => m.name || m.handle).slice(0, 4).join(", "), allowed: g.allowed, at: g.lastMessageAt, group: true })),
      ]
        .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
        .slice(0, 8);
      const person = h("input", { type: "text", placeholder: "Name", style: "max-width:160px" });
      const handle = h("input", { type: "text", placeholder: "Phone or email" });
      const add = button("Allow", async () => {
        const p = await api.addPerson({ name: person.value, handle: handle.value });
        toast(`${p.name} can now text ${name}`);
        render();
      }, { primary: true });
      body = [
        card(
          h("h3", {}, `Who can text ${name}?`),
          h("p", { class: "desc" }, `${name} only answers conversations you allow. Start with one; you can add more in Conversations.`),
          recent.length
            ? h("div", { class: "rows" },
                recent.map((c) =>
                  h("div", { class: "row" },
                    h("span", { class: `avatar${c.group ? " group" : ""}` }, c.group ? icon("conversations", 16) : initials(c.label)),
                    h("div", { class: "grow" }, h("div", { class: "title" }, c.label), h("div", { class: "sub" }, [c.sub, c.at ? relTime(c.at) : null].filter(Boolean).join(" · "))),
                    h("span", { class: "toggle-label" }, "Allow access", toggle(c.allowed, async (on) => {
                      await api.setAllowed(c.key, on);
                      render();
                    }, `Allow ${c.label}`)))))
            : h("div", { class: "empty" }, icon("conversations", 18), "Recent conversations show up here once the service can read Messages."),
          h("div", { class: "form" },
            h("label", {}, "Or add someone"), h("div", { class: "inline" }, person, handle, add),
            h("div", { class: "hint" }, "The number or Apple Account email they text from."),
          ),
        ),
        nav({ next: r.conversations.ok ? "Continue" : "Continue without one" }),
      ];
    } else if (step === 3) {
      const st = await api.settings().catch((e) => e);
      if (st instanceof Error) return page(noConfig(st));
      const f = st.fantasy;
      const league = h("input", { type: "text", class: "mono", value: f?.espnLeagueId ?? "", placeholder: "e.g. 1234567", style: "max-width:200px" });
      const cookieHint = f?.privateLeague ? "Saved (leave blank to keep)" : "Private leagues only";
      const s2 = h("input", { type: "password", class: "mono", placeholder: cookieHint, autocomplete: "off" });
      const swid = h("input", { type: "text", class: "mono", placeholder: f?.privateLeague ? cookieHint : "{XXXXXXXX-XXXX-…}", autocomplete: "off" });
      const result = h("div", { class: "setup-result" });
      // Blank cookie fields keep the saved ones; a league without saved cookies is tested as public.
      const values = () => ({ espnLeagueId: league.value, espnS2: s2.value || undefined, swid: swid.value || undefined });
      const test = async () => {
        result.replaceChildren(h("span", { class: "setup-status" }, "Checking with ESPN…"));
        try {
          const l = await api.testLeague(values());
          result.replaceChildren(status({ ok: true, detail: `${l.league} · ${l.season} season${l.currentWeek ? ` · week ${l.currentWeek}` : ""} · ${l.teams} teams` }));
          return true;
        } catch (e) {
          result.replaceChildren(status({ ok: false, detail: e.message }));
          return false;
        }
      };
      body = [
        card(
          h("h3", {}, "Connect your ESPN league (optional)"),
          h("p", { class: "desc" }, `${name} can answer start/sit, trade and matchup questions about your ESPN fantasy football league.`),
          h("div", { class: "form" },
            h("label", {}, "League ID"), league,
            h("div", { class: "hint" }, "The number after leagueId= in your league's web address on fantasy.espn.com."),
            h("label", {}, "espn_s2"), s2,
            h("label", {}, "SWID"), swid,
            h("div", { class: "hint" }, "Private leagues only. In a browser signed in to fantasy.espn.com, open the developer tools, find Cookies for espn.com, and copy espn_s2 and SWID."),
            h("label", {}, ""), h("div", { class: "inline" },
              button("Test connection", test),
              button("Save league", async () => {
                if (!(await test())) return;
                await api.saveLeague(values());
                saved("League saved");
                go(step + 1);
              }, { primary: true })),
            h("label", {}, ""), result,
            ...(f?.privateLeague
              ? [h("label", {}, ""), h("button", { class: "link", onclick: async () => {
                  try {
                    await api.saveLeague({ espnLeagueId: league.value, espnS2: "", swid: "" });
                    saved("Cookies removed; the league is treated as public");
                    render();
                  } catch (e) {
                    toast(e.message, true);
                  }
                } }, "Remove saved cookies (public league)")]
              : []),
          ),
        ),
        nav({ skip: true, next: "Continue" }),
      ];
      // "Continue" here would skip saving; the Save button moves on after a good test.
      body[1].querySelector(".btn.primary").remove();
    } else {
      const f = (await api.settings().catch(() => ({}))).fantasy;
      body = [
        card(
          h("h3", {}, r.claude.ok && r.messages.ok && r.conversations.ok ? `${name} is ready` : "Almost there"),
          h("div", { class: "rows" },
            row("Service", "Running in the background", status(s.running ? { ok: true, detail: "Running" } : { ok: false, detail: s.installed ? "Paused" : "Not installed" })),
            row("Messages", "Full Disk Access", status(r.messages)),
            row("Sending", "Automation → Messages", status(r.automation, { unknown: "Checked once the service runs" })),
            row("Sign in", r.provider === "chatgpt" ? "ChatGPT" : "Claude Code", status(r.claude)),
            row("Conversations", "Allowed to text", status(r.conversations)),
            row("Fantasy league", "ESPN", status(f ? { ok: true, detail: `League ${f.espnLeagueId}` } : null, { optional: true, unknown: "Skipped" })),
          ),
          h("p", { class: "note" }, `Text ${name} from an allowed conversation to try it. You can run setup again from the Dashboard.`),
        ),
        h("div", { class: "setup-nav" },
          button("Back", () => go(step - 1)),
          o.needsRestart && s.running
            ? button(`Restart ${name} and finish`, async () => {
                await api.restart();
                finishSetup();
              }, { primary: true })
            : button("Go to Dashboard", finishSetup, { primary: true })),
      ];
    }

    return page(body);

    function page(content) {
      return h(
        "div",
        { class: "page setup" },
        pageHead("Set up Waterboy", "A few steps so it can read and answer your iMessages.", h("button", { class: "link", onclick: finishSetup }, "Skip setup")),
        stepper,
        ...content,
      );
    }
  };

  RENDER.about = async () => {
    const [v, o] = await Promise.all([api.version(), Promise.resolve(state.overview)]);
    const p = o?.paths ?? {};
    return h(
      "div",
      { class: "page" },
      pageHead("About"),
      card(
        h("div", { class: "about-hero" }, h("img", { class: "app-icon", src: "brand.png", alt: "" }), h("div", {}, h("h3", { style: "margin:0;font-size:17px" }, "Waterboy"), h("div", { class: "desc", style: "margin:2px 0 0" }, `Version ${v.app} · Electron ${v.electron}`))),
        h("p", { style: "margin:14px 0 0" }, `A control panel for ${o?.agentName ?? "your agent"}, the assistant that answers iMessages on this Mac. The agent itself runs as a background service, so it keeps working when this window is closed.`),
      ),
      v.support
        ? card(
            h("h3", {}, "Support Waterboy"),
            h("p", { class: "desc" }, "Waterboy is made by one person in their spare time. If it's useful to you, you can buy them a beer."),
            h("div", { class: "support" },
              h("div", { class: "support-actions" },
                bmcButton(),
                h("p", { class: "desc support-scan" }, "Or scan the code with your phone."),
              ),
              h("img", { class: "support-qr", src: "support-qr.png", alt: "QR code linking to buymeacoffee.com/jgauntlettk", width: "116", height: "116" }),
            ),
          )
        : null,
      card(
        h("h3", {}, "Files"),
        h("dl", { class: "kv" },
          h("dt", {}, "Agent project"), h("dd", {}, p.project ?? "–"),
          h("dt", {}, "Config"), h("dd", {}, p.configPath ?? "–"),
          h("dt", {}, "Data"), h("dd", {}, p.dataDir ?? "–"),
          h("dt", {}, "Service"), h("dd", {}, p.plist ?? "–"),
        ),
        h("div", { class: "inline", style: "margin-top:12px" }, button("Open config", () => api.open("config"), { iconName: "external" }), button("Open data folder", () => api.open("data"), { iconName: "folder" }), button("Open project", () => api.open("project"), { iconName: "folder" })),
      ),
    );
  };

  // ---------- start ----------

  buildShell();
  if (!location.hash) location.hash = "#dashboard";
  render().then(() => {
    // First launch: walk through setup before the Dashboard.
    if (current().id === "dashboard" && needsSetup(state.overview)) location.hash = "#setup";
  });
  // Keep live pages fresh; skip while the user is typing.
  setInterval(() => {
    const page = current().id;
    if (!["dashboard", "logs"].includes(page)) return;
    if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    render();
  }, 10_000);
})();
