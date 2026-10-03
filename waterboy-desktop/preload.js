const { contextBridge, ipcRenderer } = require("electron");

// window.agent.<name>(...args) → the matching handler in main.js. Rejects with the error message.
const names = [
  "overview", "start", "pause", "restart", "logs", "conversations", "setAllowed", "addPerson", "setContactName", "setAdmin",
  "setTeam", "setAccess", "fantasyTeams", "refreshTeams", "setAlertSubscriber", "alertPlan", "setTestGroup", "runGroupSimulation", "stopGroupSimulation", "createAlertAutomations", "legacyAlerts", "previewAlertCard", "replaceLegacyAlerts", "automations", "createAutomation", "updateAutomation", "setAutomationEnabled", "deleteAutomation",
  "describeSchedule", "memories", "usage", "saveMemory", "resetSession", "settings", "saveSettings", "connections",
  "removeExtraTool", "setConnector", "open", "version", "installService", "installUpdate", "openSupport", "chatgptSignIn", "chatgptSignOut",
  "testLeague", "saveLeague", "openPrivacy",
];

const api = {};
for (const name of names) {
  api[name] = async (...args) => {
    const r = await ipcRenderer.invoke(`agent:${name}`, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
}
contextBridge.exposeInMainWorld("agent", api);
