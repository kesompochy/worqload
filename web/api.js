// The data layer: every call to the worqload HTTP API plus the per-session
// WebSocket. Functions here mutate `state`; the Svelte components re-render
// reactively off it. They don't build HTML themselves.

import { workLoad, notificationForEvent, notificationsFromSessionPoll, pendingNotificationCount } from "./notifications.js";
import { notify, fireNotification } from "./notify.js";
import { isAgentWorkEvent } from "./events-view.js";
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

// Actions are per-session: which ones apply (e.g. Preview) depends on the
// session's worktree, so they're fetched on selection rather than once globally.
export async function fetchActions(sessionId) {
  if (!sessionId) {
    state.actions = [];
    return;
  }
  try {
    const { actions } = await api("GET", `/sessions/${sessionId}/actions`);
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
  if (state.activeTab === "structure") await ensureStructureLoaded(true);
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

// The Structure tab's import-dependency graph for the selected session's
// changeset. Sets `state.structure` to the payload, or `{ error }` on failure,
// so the view can show a message rather than nothing.
export async function ensureStructureLoaded(force = false) {
  if (!state.selected) return;
  if (state.structureLoaded && !force) return;
  state.structure = { loading: true };
  const id = state.selected;
  try {
    const data = await api("GET", `/sessions/${id}/structure`);
    if (state.selected !== id) return;
    state.structure = data && data.error ? { error: data.error } : data;
  } catch (e) {
    if (state.selected !== id) return;
    state.structure = { error: e.message };
  }
  state.structureLoaded = true;
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

// Full-text search across the selected session's worktree files (Files tab's
// Ctrl+F). Returns { matches: [{ path, line, text }], truncated } — never
// throws; a failure becomes an empty result so the modal just shows "no hits".
export async function searchFiles(query) {
  if (!state.selected || !query) return { matches: [], truncated: false };
  try {
    return await api("GET", `/sessions/${state.selected}/search?q=${encodeURIComponent(query)}`);
  } catch {
    return { matches: [], truncated: false };
  }
}

// Code navigation for the Files tab: resolve a symbol's definition / references
// via the server (which uses a language server when one is available). `kind` is
// "definition" or "references"; line/character are 0-based (LSP). Returns
// `{ available: true, locations }` or `{ available: false }` (so the caller can
// fall back to the client-side heuristic) — never throws.
export async function fetchCodeNavLocations(kind, path, language, line, character) {
  if (!state.selected || !path) return { available: false };
  const params = new URLSearchParams({ path, line: String(line), character: String(character) });
  if (language) params.set("language", language);
  try {
    return await api("GET", `/sessions/${state.selected}/code-nav/${kind}?${params}`);
  } catch {
    return { available: false };
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
    // Keep the sidebar card's "last event" age in step with the live stream:
    // the 30s poll is the only other thing that refreshes lastAgentEventAt, so
    // without this a busy session's card would look like it had gone quiet
    // between polls.
    if (isAgentWorkEvent(ev)) {
      const card = state.sessions.find(s => s.id === id);
      if (card) card.lastAgentEventAt = ev.timestamp;
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
