// Wires the top-level DOM, runs the initial fetches, then keeps the sidebar
// fresh on a timer. Everything else lives in the imported modules; the
// new-session modal is a Svelte component mounted from main.ts.

import { $ } from "./dom.js";
import { state } from "./state.svelte.js";
import { startClock } from "./clock.svelte.js";
import { fetchMeta, fetchSessions } from "./api.js";
import { selectSession, switchTab } from "./handlers.js";
import { syncNotifyButton, onNotifyClick } from "./notify.js";
import { readUrlState } from "./url-state.js";

// Drives the reactive `clock` the detail pane's relative timestamps read.
startClock();

$("#btnNotify").addEventListener("click", onNotifyClick);
syncNotifyButton();

await fetchMeta();
await fetchSessions();
// Restore the session and tab the URL points at (see web/url-state.js). A
// stale id falls back to the first session so a reload after archiving still
// lands on something useful.
const urlState = readUrlState();
const restoredId = urlState.sessionId && state.sessions.some(s => s.id === urlState.sessionId)
  ? urlState.sessionId
  : (state.sessions[0]?.id ?? null);
if (restoredId) await selectSession(restoredId);
if (urlState.tab && urlState.tab !== state.activeTab) await switchTab(urlState.tab);

// Refresh the sidebar every 30s so unread-report badges and relative
// timestamps reflect activity in non-selected sessions (the WebSocket only
// streams the currently-selected session).
setInterval(() => fetchSessions(), 30_000);
