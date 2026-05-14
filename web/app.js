// Wires the top-level DOM, runs the initial fetches, then keeps the sidebar
// fresh on a timer. Everything else lives in the imported modules; the
// new-session modal is a Svelte component mounted from main.ts.

import { $ } from "./dom.js";
import { state } from "./state.svelte.js";
import { startClock } from "./clock.svelte.js";
import { fetchMeta, fetchSessions, fetchArchivedSessions } from "./api.js";
import { selectSession, switchTab, applyUrlState } from "./handlers.js";
import { syncNotifyButton, onNotifyClick } from "./notify.js";
import { readUrlState } from "./url-state.js";

// Drives the reactive `clock` the detail pane's relative timestamps read.
startClock();

$("#btnNotify").addEventListener("click", onNotifyClick);
syncNotifyButton();

await fetchMeta();
await fetchSessions();
// Restore the session, tab, and structure-focus stack the URL points at (see
// web/url-state.js). A stale id falls back to the first session so a reload
// after archiving still lands on something useful — in that case the URL is
// rewritten via replaceState so it tracks the restored view.
const urlState = readUrlState();
const restoredId = urlState.sessionId && state.sessions.some(s => s.id === urlState.sessionId)
  ? urlState.sessionId
  : (state.sessions[0]?.id ?? null);
const idMatchesUrl = restoredId === urlState.sessionId;
if (restoredId) {
  await selectSession(restoredId, { historyAction: idMatchesUrl ? "none" : "replace" });
}
if (urlState.tab && urlState.tab !== state.activeTab) {
  await switchTab(urlState.tab, { historyAction: "none" });
}
if (idMatchesUrl && urlState.focusStack.length > 0) {
  state.structureFocusStack = urlState.focusStack;
}
if (idMatchesUrl) {
  state.structureAnchor = urlState.structureAnchor;
  state.structureHops = urlState.structureHops;
  if (urlState.structureMode === "function") state.structureMode = "function";
}

// Browser Back / Forward: walk the URL stack and bring the in-memory view in
// line with whatever entry the browser navigated to.
window.addEventListener("popstate", () => {
  void applyUrlState(readUrlState());
});

// Refresh the sidebar every 30s so unread-report badges and relative
// timestamps reflect activity in non-selected sessions (the WebSocket only
// streams the currently-selected session). The archived feed is polled on the
// same tick when its tab is showing — archived sessions never gain reports,
// but the list still has to track new archives / deletions.
setInterval(() => {
  fetchSessions();
  if (state.sidebarTab === "archived") fetchArchivedSessions();
}, 30_000);
