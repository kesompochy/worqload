// Wires the top-level DOM, runs the initial fetches, then keeps the sidebar
// fresh on a timer. Everything else lives in the imported modules; the
// new-session modal is a Svelte component mounted from main.ts.

import { $ } from "./dom.js";
import { state } from "./state.js";
import { fetchMeta, fetchActions, fetchSessions } from "./api.js";
import { refreshEventsTabLabel } from "./render.js";
import { selectSession } from "./handlers.js";
import { syncNotifyButton, onNotifyClick } from "./notify.js";

$("#btnNotify").addEventListener("click", onNotifyClick);
syncNotifyButton();

await fetchMeta();
await fetchActions();
await fetchSessions();
// auto-select first session if any
if (state.sessions.length > 0) await selectSession(state.sessions[0].id);

// Refresh the sidebar every 30s so unread-report badges and relative
// timestamps reflect activity in non-selected sessions (the WebSocket only
// streams the currently-selected session). The detail view is only
// re-rendered in response to events to avoid disturbing the feedback
// textarea while the user is typing.
setInterval(() => fetchSessions(), 30_000);
// Tick the Events tab's last-update age every second so the user can see the
// session is alive without waiting for the next streamed event.
setInterval(refreshEventsTabLabel, 1_000);
