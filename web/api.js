// The data layer: every call to the worqload HTTP API plus the per-session
// WebSocket. Functions here mutate `state`; the Svelte components re-render
// reactively off it. They don't build HTML themselves.

import { workLoad, notificationForEvent, notificationsFromSessionPoll, pendingNotificationCount } from "./notifications.js";
import { notify, fireNotification } from "./notify.js";
import { state } from "./state.svelte.js";

export async function api(method, path, body) {
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchSessions() {
  const { sessions } = await api("GET", "/sessions");
  const previous = state.sessions;
  state.sessions = sessions;
  // Reports / escalations of the selected session arrive over its websocket;
  // here we cover every other session, comparing this poll to the last one.
  if (notify.active()) {
    for (const n of notificationsFromSessionPoll(previous, sessions, { selectedId: state.selected })) {
      fireNotification(n);
    }
  }
  updateDocumentTitle();
  updateLoadAverage();
}

// The "労働の load average" pill in the sidebar header: total pending work for
// the human, with the unread-report / unresolved-escalation split in its title.
export function updateLoadAverage() {
  const el = document.getElementById("loadAverage");
  if (!el) return;
  const { unreadReports, unresolvedEscalations, total } = workLoad(state.sessions);
  el.textContent = `⚖ ${total}`;
  el.classList.toggle("idle", total === 0);
  el.title = `未読レポート ${unreadReports} + 未解決エスカレ ${unresolvedEscalations}`;
}

// Persist the drag-reordered sidebar order. The caller has already mutated
// `state.sessions` so the UI reflects the new order immediately; this just
// makes it survive the 30s poll (which overwrites `state.sessions` from /sessions).
export async function reorderSessions(orderedIds) {
  await api("POST", "/sessions/order", { ids: orderedIds });
}

export async function fetchActions() {
  try {
    const { actions } = await api("GET", "/actions");
    state.actions = actions;
  } catch {
    state.actions = [];
  }
}

export async function fetchMeta() {
  try {
    const meta = await api("GET", "/meta");
    applyMeta(meta);
  } catch {
    // server didn't expose /meta yet; keep defaults
  }
}

let repoDisplayName = "worqload";

function applyMeta({ repoDir, repoName }) {
  repoDisplayName = repoName || "worqload";
  updateDocumentTitle();
  const repoEl = document.getElementById("repoName");
  if (repoEl) {
    repoEl.textContent = repoDisplayName;
    repoEl.title = repoDir || repoDisplayName;
  }
  const titleEl = document.getElementById("sidebarTitle");
  if (titleEl) titleEl.title = repoDir || repoDisplayName;
}

// Browser tab title: the repo name, prefixed with `(N) ` when N reports /
// escalations across all sessions are waiting for the human.
export function updateDocumentTitle() {
  const count = pendingNotificationCount(state.sessions);
  const prefix = count > 0 ? `(${count}) ` : "";
  document.title = `${prefix}${repoDisplayName} · worqload`;
}

export async function refreshDetail() {
  if (!state.selected) return;
  const id = state.selected;
  const [{ meta, events }, reportsRes, askingRes, feedbackRes] = await Promise.all([
    api("GET", `/sessions/${id}`),
    api("GET", `/sessions/${id}/reports`),
    api("GET", `/sessions/${id}/asking`),
    api("GET", `/sessions/${id}/feedback`),
  ]);
  state.detail = { meta, events };
  state.reports = reportsRes.reports;
  state.asking = askingRes.asking;
  state.feedbackHistory = feedbackRes.messages;
  state.lastSeq = events.length > 0 ? events[events.length - 1].seq : 0;
  if (state.activeTab === "diff") await refreshDiff();
  if (state.activeTab === "files") await ensureFilesLoaded(true);
}

export async function ensureFilesLoaded(force = false) {
  if (!state.selected) return;
  if (state.filesLoaded && !force) return;
  try {
    const { paths } = await api("GET", `/sessions/${state.selected}/files`);
    state.files = Array.isArray(paths) ? paths : [];
  } catch {
    state.files = [];
  }
  state.filesLoaded = true;
}

export async function selectFile(path) {
  if (!state.selected || !path) return;
  state.selectedFilePath = path;
  state.fileContent = { path, loading: true };
  let next;
  try {
    const res = await fetch(`/sessions/${state.selected}/file?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      next = await res.json();
    } else {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
      next = { path, error: msg };
    }
  } catch (e) {
    next = { path, error: e.message };
  }
  // A newer click may have superseded this fetch; only apply if still current.
  if (state.selectedFilePath === path) {
    state.fileContent = next;
  }
}

export async function refreshDiff() {
  if (!state.selected) return;
  let next = "";
  try {
    const res = await fetch(`/sessions/${state.selected}/diff`);
    next = res.ok ? await res.text() : "";
  } catch {
    next = "";
  }
  if (next !== state.diff) {
    // Line numbers may have shifted; previously expanded ranges no longer apply.
    state.diff = next;
    state.diffExpansions = new Map();
  }
}

export function openWs(id) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/sessions/${id}/stream`);
  state.ws = ws;
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "subscribe", lastSeq: state.lastSeq }));
  });
  ws.addEventListener("message", async e => {
    let payload; try { payload = JSON.parse(e.data); } catch { return; }
    const ev = payload.event;
    if (!ev || ev.seq <= state.lastSeq) return;
    state.lastSeq = ev.seq;
    if (state.detail) {
      state.detail.events = [...(state.detail.events ?? []), ev];
    }
    // For "interesting" events refresh the relevant slice.
    if (ev.kind === "report_submitted" || ev.kind === "report_read" || ev.kind === "report_unread"
        || ev.kind === "feedback_received" || ev.kind === "feedback_fetched"
        || ev.kind === "escalation_requested" || ev.kind === "escalation_resolved"
        || ev.kind === "session_stopped" || ev.kind === "session_crashed" || ev.kind === "session_resumed") {
      await refreshDetail();
      if (notify.active()) {
        const n = notificationForEvent(ev, { session: state.detail?.meta, reports: state.reports, asking: state.asking });
        if (n) fireNotification(n);
      }
      await fetchSessions();
    }
  });
  ws.addEventListener("close", () => {
    if (state.ws === ws) state.ws = null;
  });
}
