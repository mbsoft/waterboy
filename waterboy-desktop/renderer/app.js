/* global ICONS */
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
  ];
  const state = { overview: null, logPage: 0, logFilter: "all", memoryDir: null, newAutomation: false, editAutomation: null };

  function buildShell() {
    const nav = $("#nav");
    for (const p of PAGES) {
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

  const current = () => PAGES.find((p) => `#${p.id}` === location.hash) ?? PAGES[0];

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
    if (o) foot.append(o.status.running ? h("span", { class: "pulse" }) : icon("pause", 13), o.status.running ? "Running" : o.status.installed ? "Paused" : "Not installed");
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
      syncScroll();
    } catch (e) {
      if (seq !== renderSeq) return;
      content.replaceChildren(h("div", { class: "page" }, card(h("div", { class: "empty" }, icon("alert", 18), e.message))));
    } finally {
      refresh.classList.remove("spin");
    }
  }

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
  const saved = (what = "Saved") => toast(state.overview?.status.running ? `${what}. Restart the agent to apply.` : what);

  // ---------- pages ----------

  const RENDER = {};

  RENDER.dashboard = async () => {
    const o = state.overview;
    if (!o) throw new Error("Couldn't reach the agent.");
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
          h("p", {}, setup.state === "blocked" ? setup.reason : setup.bundled ? `Install the ${name} service so it can reply to your messages.` : "Run npm run install-service in the agent project to set it up."),
        ),
        setup.bundled && setup.state !== "blocked"
          ? button("Install service", async () => {
              await api.installService();
              toast("Service installed");
              render();
            }, { primary: true, lg: true, iconName: "play" })
          : null,
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
      restartBanner(),
      card(h("h3", {}, `${name} status`), h("div", { class: "status" }, statusBody)),
      card(h("div", { class: "readiness" }, h("h3", {}, "Setup readiness"), h("div", { class: "checks" }, check(r.provider === "chatgpt" ? "ChatGPT" : "Claude Code", r.claude), check("Messages", r.messages), check("Conversations", r.conversations)))),
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
      card(
        h("h3", {}, `Use ${name} in Messages`),
        h("p", { class: "desc", style: "color:var(--text);margin-top:8px" }, `Text ${name} from an allowed conversation. In group chats, mention ${name} by name to get a reply.`),
        h("p", { class: "desc" }, "Try /help in a chat for commands like /new, /memory, /pause and /status."),
        h("div", { class: "inline", style: "gap:18px" }, linkTo("conversations", "Manage conversations", "conversations"), linkTo("settings", "Open Settings", "settings")),
      ),
    );
  };
  const stat = (num, lbl) => h("div", { class: "stat" }, h("div", { class: "num" }, num), h("div", { class: "lbl" }, lbl));
  const linkTo = (page, label, iconName) => h("button", { class: "link", onclick: () => (location.hash = `#${page}`) }, icon(iconName, 16), label);

  RENDER.connections = async () => {
    const c = await api.connections();
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
    const conditionText = { fantasy_week_final: "When every NFL game of the week is final" };
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
    const condition = h("select", {}, h("option", { value: "" }, "Every time it's scheduled"), h("option", { value: "fantasy_week_final" }, "Only once every NFL game of the week is final"));
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
    const [s, teams] = await Promise.all([api.settings(), api.fantasyTeams().catch(() => [])]);
    const save = async (patch, msg) => {
      await api.saveSettings(patch);
      saved(msg);
      await refreshOverview();
      const b = restartBanner();
      const old = document.querySelector(".page > .banner");
      if (old) old.replaceWith(b ?? document.createComment(""));
      else if (b) document.querySelector(".page-head").after(b);
    };
    const textSetting = (key, value, attrs = {}) => {
      const input = h("input", { type: "text", value, ...attrs });
      const b = button("Save", async () => {
        await save({ [key]: input.value });
        b.disabled = true;
        value = input.value;
      });
      b.disabled = true;
      input.addEventListener("input", () => (b.disabled = input.value === String(value)));
      input.addEventListener("keydown", (e) => e.key === "Enter" && !b.disabled && b.click());
      return h("div", { class: "inline" }, input, b);
    };
    const models = [
      ["", "Claude Code default"],
      ["claude-opus-5-5", "Claude Opus 5.5"],
      ["claude-sonnet-5", "Claude Sonnet 5"],
      ["claude-fable-5-1", "Claude Fable 5.1"],
      ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
    ];
    const model = h("select", {}, models.map(([v, l]) => h("option", { value: v }, l)));
    if (s.model && !models.some(([v]) => v === s.model)) model.append(h("option", { value: s.model }, s.model));
    model.value = s.model ?? "";
    model.addEventListener("change", () => save({ model: model.value || null }, "Model saved").catch((e) => toast(e.message, true)));

    // ChatGPT: the plan's models come from Codex's model list (known after the first reply).
    const g = s.chatgpt;
    const gptModels = [["", "ChatGPT plan default"], ...g.models.map((m) => [m.id, m.name])];
    const gptModel = h("select", {}, gptModels.map(([v, l]) => h("option", { value: v }, l)));
    if (g.model && !gptModels.some(([v]) => v === g.model)) gptModel.append(h("option", { value: g.model }, g.model));
    gptModel.value = g.model ?? "";
    gptModel.addEventListener("change", () => save({ "chatgpt.model": gptModel.value || null }, "Model saved").catch((e) => toast(e.message, true)));

    const provider = h("select", { "aria-label": "Assistant" }, h("option", { value: "claude" }, "Claude"), h("option", { value: "chatgpt" }, "ChatGPT"));
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
            h("label", {}, "Model"), gptModel,
            h("div", { class: "hint" }, g.models.length ? "Models available on your ChatGPT plan." : "More models appear here after the first reply."),
          ]
        : [h("label", {}, "Model"), model, h("div", { class: "hint" }, "Uses your Claude Code sign-in.")];

    const f = s.fantasy;
    let fantasyCard = null;
    if (f) {
      const mine = h("select", {}, h("option", { value: "" }, "Not set"), teams.map((t) => h("option", { value: t.id }, t.name)));
      mine.value = f.myTeamId ?? "";
      mine.addEventListener("change", () => save({ "fantasy.myTeamId": mine.value }).catch((e) => toast(e.message, true)));
      fantasyCard = card(
        h("h3", {}, "Fantasy football"),
        h("div", { class: "form" },
          h("label", {}, "ESPN league ID"), textSetting("fantasy.espnLeagueId", f.espnLeagueId, { class: "mono", style: "max-width:200px" }),
          h("label", {}, "Default team"), mine,
          h("div", { class: "hint" }, 'Used for "my team" when the person asking has no team set in Conversations.'),
          h("label", {}, "Sleeper data"), h("span", { class: "toggle-label" }, toggle(f.sleeper, (on) => save({ "fantasy.sleeper": on }), "Sleeper data"), "Second-opinion projections and trending players"),
          h("label", {}, "NFL usage stats"), h("span", { class: "toggle-label" }, toggle(f.nflverse, (on) => save({ "fantasy.nflverse": on }), "NFL usage stats"), "Snap %, targets, expected points and injury reports from nflverse"),
          h("div", { class: "hint" },
            f.nflverseUpdatedAt
              ? `Downloaded from GitHub about once a day. Last updated ${relTime(f.nflverseUpdatedAt)}.`
              : f.nflverse ? "Downloads from GitHub about once a day, starting the next time the agent starts." : "Off. The agent won't download or use nflverse data."),
          h("label", {}, "Betting lines"), h("span", { class: "toggle-label" }, toggle(f.vegas, (on) => save({ "fantasy.vegas": on }), "Betting lines"), "Spreads, implied team points and weather in previews and answers"),
          h("label", {}, "Expert rankings"), h("span", { class: "toggle-label" }, toggle(f.rankings, (on) => save({ "fantasy.rankings": on }), "Expert rankings"), "FantasyPros consensus rankings for start/sit questions"),
          h("label", {}, "Trade values"), h("span", { class: "toggle-label" }, toggle(f.tradeValues, (on) => save({ "fantasy.tradeValues": on }), "Trade values"), "FantasyCalc values for \"is this trade fair?\""),
          h("label", {}, "Dynasty league"), h("span", { class: "toggle-label" }, toggle(f.dynasty, (on) => save({ "fantasy.dynasty": on }), "Dynasty league"), "Value players for future seasons too (trade values)"),
        ),
      );
    }

    return h(
      "div",
      { class: "page" },
      pageHead("Settings", "Choose how the agent behaves on this Mac."),
      restartBanner(),
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
      card(
        h("h3", {}, "Group chats"),
        h("div", { class: "form" },
          h("label", {}, "Wake words"), textSetting("groupTriggers", s.groupTriggers.join(", ")),
          h("div", { class: "hint" }, "Comma-separated. The agent replies in groups when a message contains one of these."),
          h("label", {}, "Reply to everything"), h("span", { class: "toggle-label" }, toggle(s.respondToAllInGroups, (on) => save({ respondToAllInGroups: on }), "Reply to every group message"), "Answer every group message, not only mentions"),
        ),
      ),
      card(
        h("h3", {}, "Google Calendar"),
        (() => {
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
            } catch (e) {
              toast(e.message, true);
            }
          });
          return h("div", { class: "form" },
            h("label", {}, "Access"), level, describe && hint,
            h("p", { class: "note full", style: "margin:0" },
              s.provider === "chatgpt"
                ? "Only available with Claude as the assistant: it uses the Google Calendar connector on your Claude account."
                : "Uses the Google Calendar connector on your Claude account (claude.ai → Settings → Connectors) and only works in 1:1 chats with Everything access. Group chats and fantasy-only people never get it."),
          );
        })(),
      ),
      card(
        h("h3", {}, "Messages"),
        h("div", { class: "form" },
          h("label", {}, "Transcribe"), h("span", { class: "toggle-label" }, toggle(s.voice.enabled, (on) => save({ "voice.enabled": on }), "Transcribe voice messages"), "Transcribe incoming voice messages on this Mac"),
          h("div", { class: "hint" }, "Uses whisper.cpp locally. Nothing is uploaded."),
          h("label", {}, "Typing indicator"), h("span", { class: "toggle-label" }, toggle(s.typingIndicators, (on) => save({ typingIndicators: on }), "Typing indicator"), "Show \u201ctyping\u2026\u201d in the chat while a reply is being written"),
          h("div", { class: "hint" }, "Needs Accessibility access for Waterboy (System Settings → Privacy & Security → Accessibility). Uses a hidden second copy of Messages; one chat shows typing at a time."),
        ),
      ),
      card(
        h("h3", {}, "Limits and safety"),
        h("div", { class: "form" },
          h("label", {}, "Max steps per reply"), textSetting("maxTurns", String(s.maxTurns), { style: "max-width:90px" }),
          s.provider === "chatgpt" ? h("div", { class: "hint" }, "Claude only. ChatGPT replies are limited by the reply timeout.") : null,
          h("label", {}, "Reply timeout (min)"), (() => {
            let minutes = String(Math.round(s.turnTimeoutMs / 60000));
            const input = h("input", { type: "text", value: minutes, style: "max-width:90px" });
            const b = button("Save", async () => {
              await save({ turnTimeoutMs: Number(input.value) * 60000 });
              minutes = input.value;
              b.disabled = true;
            });
            b.disabled = true;
            input.addEventListener("input", () => (b.disabled = input.value === minutes || !(Number(input.value) > 0)));
            return h("div", { class: "inline" }, input, b);
          })(),
          h("label", {}, "Shell commands"), h("span", { class: "toggle-label" }, toggle(s.allowBash, (on) => save({ allowBash: on }), "Allow shell commands"), "Let the agent run commands on this Mac"),
          h("div", { class: "hint", style: s.allowBash ? "color:var(--warn)" : "" },
            s.provider === "chatgpt"
              ? "Anyone in an allowed 1:1 conversation could then run commands here. With ChatGPT they run in a sandbox that can read this Mac but only write to the chat folder, without network access. Leave off unless you need it."
              : "Anyone in an allowed 1:1 conversation could then run commands here. Leave off unless you need it."),
        ),
      ),
      fantasyCard,
    );
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
      v.coffee
        ? card(
            h("h3", {}, "Support Waterboy"),
            h("p", { class: "desc" }, "Waterboy is made by one person in their spare time. If it's useful to you, you can buy them a coffee."),
            h("div", { class: "inline", style: "margin-top:12px" }, button("Buy me a coffee", () => api.openCoffee(), { primary: true, iconName: "coffee" })),
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
  render();
  // Keep live pages fresh; skip while the user is typing.
  setInterval(() => {
    const page = current().id;
    if (!["dashboard", "logs"].includes(page)) return;
    if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    render();
  }, 10_000);
})();
