/**
 * Turns the service's agent.log ("<ISO time> [tag] message") into readable events.
 * Pure functions, so they're unit-tested without the service.
 */

const LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[(\w+)\] (.*)$/;

/**
 * @returns events oldest first: { at, kind, title, detail, chat?, seconds?, model? }
 * kind: "reply" | "turn" | "ignored" | "start" | "stop" | "session" | "error" | "info"
 */
function parseLog(text) {
  const events = [];
  // Turn-start times waiting for their "turn cost"/"turn used" line, for logs written before the
  // service recorded each turn's duration ("… in 13.4s"). A start with no end (an error, a
  // restart mid-turn) must not be paired with a later reply, so only recent starts count.
  const openTurns = [];
  const MAX_TURN_MS = 15 * 60_000; // replies time out after 10 minutes by default
  for (const raw of text.split("\n")) {
    const m = raw.match(LINE);
    if (!m) continue;
    const [, at, tag, msg] = m;
    let e;
    let x;
    if ((x = msg.match(/^(.+?) agent started\. Watching/))) e = { kind: "start", title: "Agent started", detail: `${x[1]} is watching Messages` };
    else if (/SIGTERM received|SIGINT received/.test(msg)) e = { kind: "stop", title: "Agent stopping", detail: "Finishing in-flight replies" };
    else if (/^allowlisted chats:/.test(msg)) continue;
    else if ((x = msg.match(/^assistant: (Claude|ChatGPT)(?: \((.+)\))?$/))) e = { kind: "info", title: `Assistant: ${x[1]}`, detail: x[2] ?? "" };
    else if (tag === "imessage" && /need Accessibility access/.test(msg))
      e = { kind: "error", title: "Typing indicators need Accessibility", detail: "System Settings → Privacy & Security → Accessibility → turn on Waterboy" };
    else if (tag === "imessage" && /^typing indicators on/.test(msg)) e = { kind: "info", title: "Typing indicators on", detail: msg };
    else if ((x = msg.match(/^group and fantasy chats are off: (.+)$/))) e = { kind: "error", title: "Group chats paused", detail: `Codex turned on features Waterboy hasn't reviewed: ${x[1].replace(/^unreviewed Codex features /, "")}` };
    else if ((x = msg.match(/^session (\S+) \(auth: (\w+), model: (.+)\)$/))) {
      openTurns.push(Date.parse(at));
      e = { kind: "turn", title: "Working on a reply", detail: x[3], model: x[3] };
    } else if ((x = msg.match(/^(.+): turn (?:cost \$[\d.]+|used \d+ tokens)/))) {
      const end = Date.parse(at);
      while (openTurns.length && end - openTurns[0] > MAX_TURN_MS) openTurns.shift(); // stale: that turn never finished
      const started = openTurns.shift();
      const logged = msg.match(/ in ([\d.]+)s$/);
      const seconds = logged ? Number(logged[1]) : started !== undefined ? Math.round((end - started) / 100) / 10 : null;
      e = { kind: "reply", title: "Reply delivered", chat: x[1], seconds, detail: [x[1], seconds !== null ? `${seconds} s` : null].filter(Boolean).join(" · ") };
    } else if ((x = msg.match(/^ignoring message from non-allowlisted chat (\S+) \(sender (\S+), name (.+)\)$/))) {
      e = { kind: "ignored", title: "Message ignored", chat: x[1], detail: `${x[3] !== "-" ? x[3] : x[2]} isn't allowed yet` };
    } else if ((x = msg.match(/^(.+): policy changed, starting a fresh session/))) {
      e = { kind: "session", title: "Fresh session", chat: x[1], detail: `${x[1]} · instructions updated` };
    } else if ((x = msg.match(/^resume of (\S+) failed/))) {
      e = { kind: "session", title: "Session restarted", detail: "Couldn't resume the previous conversation" };
    } else if (/fail|error|couldn't|cannot|unavailable/i.test(msg)) {
      e = { kind: "error", title: errorTitle(tag, msg), detail: msg };
    } else {
      e = { kind: "info", title: infoTitle(tag), detail: msg };
    }
    events.push({ at, tag, ...e });
  }
  return events;
}

function errorTitle(tag, msg) {
  if (tag === "sleeper") return "Sleeper data unavailable";
  if (tag === "fantasy") return "Fantasy lookup failed";
  if (/poll error/.test(msg)) return "Couldn't read Messages";
  if (/send|osascript/i.test(msg)) return "Couldn't send a message";
  return "Problem";
}

function infoTitle(tag) {
  return { bot: "Conversation", scheduler: "Automation", fantasy: "Fantasy football", main: "Agent", agent: "Agent" }[tag] ?? "Activity";
}

/** Today's numbers for the dashboard. */
function summarize(events, now = new Date()) {
  const today = now.toDateString();
  const todays = events.filter((e) => new Date(e.at).toDateString() === today);
  const replies = todays.filter((e) => e.kind === "reply");
  const times = replies.map((e) => e.seconds).filter((s) => s !== null);
  const lastReply = [...events].reverse().find((e) => e.kind === "reply") ?? null;
  return {
    repliesToday: replies.length,
    avgSeconds: times.length ? Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10 : null,
    ignoredToday: todays.filter((e) => e.kind === "ignored").length,
    errorsToday: todays.filter((e) => e.kind === "error").length,
    lastReplyAt: lastReply?.at ?? null,
  };
}

module.exports = { parseLog, summarize };
