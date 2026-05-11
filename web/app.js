// Entry point: wire the top-level DOM, run the initial fetches, then keep the
// sidebar fresh on a timer. Everything else lives in the imported modules.

import { $ } from "./dom.js";
import { state } from "./state.js";
import { fetchMeta, fetchActions, fetchSessions } from "./api.js";
import { refreshEventsTabLabel } from "./render.js";
import { selectSession, openModal, closeModal, createSession } from "./handlers.js";
import { syncNotifyButton, onNotifyClick } from "./notify.js";

$("#btnNew").addEventListener("click", openModal);
$("#btnNotify").addEventListener("click", onNotifyClick);
$("#modalCancel").addEventListener("click", closeModal);
$("#modalCreate").addEventListener("click", createSession);
$("#modalPrompt").addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); createSession(); }
});
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
