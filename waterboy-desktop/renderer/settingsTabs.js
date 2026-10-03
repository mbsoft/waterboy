// The Settings page's tabs (#settings/<tab>) and the settings each one holds. Loaded by the
// renderer as a plain script (window.SETTINGS_TABS) and by the tests with require().
(function (root) {
  const TABS = [
    { id: "general", label: "General", settings: ["agentName", "provider", "model", "chatgpt.model"] },
    {
      id: "conversations",
      label: "Conversations",
      settings: ["groupTriggers", "respondToAllInGroups", "voice.enabled", "typingIndicators", "threadedReplies"],
    },
    {
      id: "fantasy",
      label: "Fantasy",
      settings: [
        "fantasy.espnLeagueId", "fantasy.myTeamId", "fantasy.dynasty",
        "fantasy.sleeper", "fantasy.nflverse", "fantasy.vegas", "fantasy.rankings", "fantasy.tradeValues",
        "fantasy.startSitCards", "fantasy.tradeCards", "fantasy.compareCards",
        "fantasy.roundupAwards.playoffOdds", "fantasy.roundupAwards.highLow", "fantasy.roundupAwards.blowout",
        "fantasy.roundupAwards.closest", "fantasy.roundupAwards.benchBlunder", "fantasy.roundupAwards.luckyWin",
        "fantasy.roundupAwards.toughLoss", "fantasy.roundupAwards.topPlayer", "fantasy.roundupRenames",
      ],
    },
    {
      id: "alerts",
      label: "Live alerts",
      settings: [
        "fantasy.liveAlerts.enabled", "fantasy.liveAlerts.thresholdPct", "fantasy.liveAlerts.checkMinutes", "fantasy.liveAlerts.minPlayerPoints",
        "fantasy.liveAlerts.caption",
        "fantasy.liveAlerts.groupTest.enabled", "fantasy.liveAlerts.groupTest.chatId", "fantasy.liveAlerts.groupTest.source",
        "fantasy.liveAlerts.groupTest.maxPerCheck", "fantasy.liveAlerts.groupTest.cooldownMinutes",
      ],
    },
    { id: "advanced", label: "Advanced", settings: ["maxTurns", "turnTimeoutMs", "allowBash", "usage.dailyCostAlertUsd"] },
  ];

  /** "#settings/fantasy" → { page: "settings", tab: "fantasy" }. Settings without a known tab opens General. */
  function parseRoute(hash) {
    const [page = "", sub] = String(hash ?? "").replace(/^#/, "").split("/");
    if (page !== "settings") return { page, tab: null };
    return { page, tab: TABS.some((t) => t.id === sub) ? sub : "general" };
  }

  const api = { TABS, parseRoute };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SETTINGS_TABS = api;
})(this);
