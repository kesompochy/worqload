// The data layer: every call to the worqload HTTP API plus the per-session
// WebSocket. Functions here mutate `state`; the Svelte components re-render
// reactively off it. They don't build HTML themselves.

import { workLoad, notificationForEvent, notificationsFromSessionPoll, pendingNotificationCount } from "./notifications.js";
import { notify, fireNotification } from "./notify.js";
import { isAgentWorkEvent } from "./events-view.js";
import { state } from "./state.svelte.js";
import { toast } from "./dom.js";

export async function api(method, path, body) {
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// Posts a feedback message, choosing JSON or multipart/form-data based on
// whether attachments are queued. The server accepts both shapes; the
// multipart branch wraps the existing payload as a single `payload` JSON field
// alongside one `attachment` field per file, which avoids base64 inflating the
// uploads.
export async function submitFeedback(sessionId, payload, attachments) {
  if (!attachments || attachments.length === 0) {
    return api("POST", `/sessions/${sessionId}/feedback`, payload);
  }
  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  for (const att of attachments) form.append("attachment", att.file);
  const path = `/sessions/${sessionId}/feedback`;
  const res = await fetch(path, { method: "POST", body: form });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchSessions() {
  const { sessions } = await api("GET", "/sessions");
  const previous = state.sessions;
  state.sessions = sessions;
  // Reports / escalations of the selected session arrive over its websocket;
  // here we cover every other session, comparing this poll to the last one.
  // Archived sessions never gain new reports, so they don't enter this diff.
  if (notify.active()) {
    for (const n of notificationsFromSessionPoll(previous, sessions, { selectedId: state.selected })) {
      fireNotification(n);
    }
  }
  updateDocumentTitle();
  updateLoadAverage();
  prefetchPrLinks();
}

// The archived-tab feed. Kept separate from `state.sessions` so the active
// list — and the notification / load-average derivations that read it — stay
// untouched while the human browses archives.
export async function fetchArchivedSessions() {
  const { sessions } = await api("GET", "/sessions?archived=only");
  state.archivedSessions = sessions;
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

function applyMeta({ repoDir, repoName, agentName, driverName }) {
  repoDisplayName = repoName || "worqload";
  updateDocumentTitle();
  const repoEl = document.getElementById("repoName");
  if (repoEl) {
    repoEl.textContent = repoDisplayName;
    repoEl.title = repoDir || repoDisplayName;
  }
  const titleEl = document.getElementById("sidebarTitle");
  if (titleEl) titleEl.title = repoDir || repoDisplayName;
  const infoEl = document.getElementById("serverInfo");
  if (infoEl) {
    const parts = [];
    if (agentName) parts.push(agentName);
    if (driverName) parts.push(driverName);
    infoEl.textContent = parts.length > 0 ? parts.join(" / ") : "";
  }
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
  const [{ meta, events, agentName }, reportsRes, askingRes, feedbackRes] = await Promise.all([
    api("GET", `/sessions/${id}`),
    api("GET", `/sessions/${id}/reports`),
    api("GET", `/sessions/${id}/asking`),
    api("GET", `/sessions/${id}/feedback`),
  ]);
  state.detail = { meta, events, agentName };
  state.reports = reportsRes.reports;
  state.asking = askingRes.asking;
  state.feedbackHistory = feedbackRes.messages;
  state.lastSeq = events.length > 0 ? events[events.length - 1].seq : 0;
  if (state.activeTab === "diff") await refreshDiff();
  if (state.activeTab === "files") await ensureFilesLoaded(true);
  if (state.activeTab === "structure") await ensureStructureViewLoaded(true);
}

// The PR (if any) tracking a session's branch on the remote. Fire-and-forget —
// the server resolver may make a network call — so callers `void` this. The
// result lands in the prLinks cache (so a later open reads it with no delay)
// and, if that session is the one on screen, in prLink (what the header reads).
// `fresh` bypasses the server cache: used right after create-pr so the new PR
// shows immediately instead of after the cache TTL.
export async function loadPrLink(id, { fresh = false } = {}) {
  try {
    const res = await api("GET", `/sessions/${id}/pr-link${fresh ? "?fresh=1" : ""}`);
    state.prLinks = { ...state.prLinks, [id]: res };
    if (state.selected === id) state.prLink = res;
  } catch {
    /* leave the cache entry as-is so the next poll retries */
  }
}

// Warm the prLinks cache for every active session in the background. Driven by
// the session-list poll (boot + every 30s) so by the time the human opens a
// session its link is already in hand. Re-requested every poll rather than
// once: the server-side TTL cache turns most of these into instant hits (no
// `gh` respawn), while the ones past the TTL refresh the link so a PR opened
// outside worqload still surfaces without a reload.
export function prefetchPrLinks() {
  for (const s of state.sessions) void loadPrLink(s.id);
}

// One-stop loader for whichever Structure-tab snapshots the current mode
// needs: After + Before for that mode. Before always fires alongside After —
// the Split toggle is visibility-only, so the Before payload is ready by the
// time the human clicks it. We await After (the human is staring at it) but
// fire Before with `void` so it doesn't delay the After render when the
// language server hasn't started up yet.
export async function ensureStructureViewLoaded(force = false) {
  if (!state.selected) return;
  if (state.structureMode === "function") {
    await ensureCallGraphLoaded(force);
    void ensureCallGraphBeforeLoaded(force);
  } else {
    await ensureStructureLoaded(force);
    void ensureStructureBeforeLoaded(force);
  }
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

// The Structure tab's import-dependency graph for the selected session.
// By default the graph is scoped to the session's diff; if
// `state.structureAnchor` is set the graph is rebuilt around that anchor file
// instead, and `state.structureHops` (when set) overrides the neighbourhood
// radius. Sets `state.structure` to the payload, or `{ error }` on failure,
// so the view can show a message rather than nothing.
export async function ensureStructureLoaded(force = false) {
  if (!state.selected) return;
  if (state.structureLoaded && !force) return;
  state.structure = { loading: true };
  const id = state.selected;
  const path = `/sessions/${id}/structure${buildStructureQuery()}`;
  try {
    const data = await api("GET", path);
    if (state.selected !== id) return;
    state.structure = data && data.error ? { error: data.error } : data;
  } catch (e) {
    if (state.selected !== id) return;
    state.structure = { error: e.message };
  }
  state.structureLoaded = true;
}

// The diff-base "Before" counterpart to ensureStructureLoaded. Tracked on its
// own `structureBeforeLoaded` flag so the same anchor/hops invalidations that
// drop `structure` also drop `structureBefore`. Called eagerly alongside the
// After fetch so flipping the Split toggle is instantaneous; the extra cost
// is a few git reads against the diff-base tree.
export async function ensureStructureBeforeLoaded(force = false) {
  if (!state.selected) return;
  if (state.structureBeforeLoaded && !force) return;
  state.structureBefore = { loading: true };
  const id = state.selected;
  const path = `/sessions/${id}/structure${buildStructureQuery({ side: "before" })}`;
  try {
    const data = await api("GET", path);
    if (state.selected !== id) return;
    state.structureBefore = data && data.error ? { error: data.error } : data;
  } catch (e) {
    if (state.selected !== id) return;
    state.structureBefore = { error: e.message };
  }
  state.structureBeforeLoaded = true;
}

function buildStructureQuery({ side } = {}) {
  const params = new URLSearchParams();
  if (state.structureAnchor && state.structureAnchor.kind === "file") {
    params.set("anchorPath", state.structureAnchor.path);
  }
  if (typeof state.structureHops === "number") {
    params.set("hops", String(state.structureHops));
  }
  if (side === "before") params.set("side", "before");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// Function-mode counterpart: LSP-driven call graph. By default seeded by the
// changeset's callable symbols; if `state.structureAnchor` is a symbol the
// walk pins to that one function instead, and if it's a file the walk pins to
// every callable symbol in that file. Slower than the import graph (each
// query goes out to a language server), so it loads on demand when the user
// flips the toolbar mode toggle.
export async function ensureCallGraphLoaded(force = false) {
  if (!state.selected) return;
  if (state.callGraphLoaded && !force) return;
  state.callGraph = { loading: true };
  const id = state.selected;
  const path = `/sessions/${id}/call-graph${buildCallGraphQuery()}`;
  try {
    const data = await api("GET", path);
    if (state.selected !== id) return;
    state.callGraph = data && data.error ? { error: data.error } : data;
  } catch (e) {
    if (state.selected !== id) return;
    state.callGraph = { error: e.message };
  }
  state.callGraphLoaded = true;
}

// Function-mode Before: the call graph at the diff base, computed by a second
// LSP rooted in a sibling worktree at that revision. The server materialises
// the sibling on demand the first time this fetch lands. Triggered alongside
// the After call graph whenever the Structure tab is on function mode so
// flipping Split shows the Before half immediately.
export async function ensureCallGraphBeforeLoaded(force = false) {
  if (!state.selected) return;
  if (state.callGraphBeforeLoaded && !force) return;
  state.callGraphBefore = { loading: true };
  const id = state.selected;
  const path = `/sessions/${id}/call-graph${buildCallGraphQuery({ side: "before" })}`;
  try {
    const data = await api("GET", path);
    if (state.selected !== id) return;
    state.callGraphBefore = data && data.error ? { error: data.error } : data;
  } catch (e) {
    if (state.selected !== id) return;
    state.callGraphBefore = { error: e.message };
  }
  state.callGraphBeforeLoaded = true;
}

function buildCallGraphQuery({ side } = {}) {
  const params = new URLSearchParams();
  const anchor = state.structureAnchor;
  if (anchor && anchor.path) {
    params.set("anchorPath", anchor.path);
    if (anchor.kind === "symbol" && typeof anchor.line === "number") {
      // state stores 1-based line for human-readability; LSP wants 0-based.
      params.set("anchorLine", String(anchor.line - 1));
      if (typeof anchor.character === "number") {
        params.set("anchorCharacter", String(anchor.character));
      }
    }
  }
  if (side === "before") params.set("side", "before");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function selectFile(path) {
  if (!state.selected || !path) return;
  // Opening a file always starts in the read-only view, even when re-opening
  // the one already on screen — a half-written editor draft or rename input
  // for the old file must not survive into the new fetch.
  state.fileEditing = false;
  state.fileRenaming = false;
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

// Save the Files-tab editor's draft back to its worktree file. On success the
// in-memory file content is replaced with the saved text and edit mode closes;
// on failure the editor stays open so the draft survives a retry. A file
// switch mid-flight (selectedFilePath moved on) leaves the view untouched —
// the write still landed on disk.
export async function saveFile() {
  const path = state.selectedFilePath;
  if (!state.selected || !path || !state.fileEditing) return;
  const content = state.fileEditDraft;
  try {
    await api("PUT", `/sessions/${state.selected}/file?path=${encodeURIComponent(path)}`, { content });
  } catch {
    toast("保存に失敗しました");
    return;
  }
  if (state.selectedFilePath === path) {
    state.fileContent = { path, content };
    state.fileEditing = false;
  }
  toast("ファイルを保存しました");
}

// Create a new worktree file from the Files-tab new-file input, then open it
// in the content pane already in edit mode (a just-created file exists to be
// written into). A name clash (409) or other failure leaves the input open so
// the human can adjust the path.
export async function createFile(path) {
  const trimmed = (path ?? "").trim();
  if (!state.selected || trimmed === "") return;
  let res;
  try {
    res = await fetch(`/sessions/${state.selected}/file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: trimmed, content: "" }),
    });
  } catch {
    toast("ファイルの作成に失敗しました");
    return;
  }
  if (!res.ok) {
    toast(res.status === 409 ? "同名のファイルが既にあります" : "ファイルの作成に失敗しました");
    return;
  }
  state.fileCreating = false;
  state.fileNewPath = "";
  await ensureFilesLoaded(true);
  await selectFile(trimmed);
  if (state.selectedFilePath === trimmed && typeof state.fileContent?.content === "string") {
    state.fileEditDraft = state.fileContent.content;
    state.fileEditing = true;
  }
}

// Delete a worktree file. On success the tree refreshes and, if the deleted
// file was the one on screen, the content pane clears.
export async function deleteFile(path) {
  if (!state.selected || !path) return;
  try {
    await api("DELETE", `/sessions/${state.selected}/file?path=${encodeURIComponent(path)}`);
  } catch {
    toast("ファイルの削除に失敗しました");
    return;
  }
  if (state.selectedFilePath === path) {
    state.selectedFilePath = null;
    state.fileContent = null;
    state.fileEditing = false;
  }
  await ensureFilesLoaded(true);
  toast("ファイルを削除しました");
}

// Rename the file open in the Files-tab content pane to the path typed into
// the header's rename input, then re-open it at its new path. A no-op rename
// (unchanged path) just closes the input; a name clash (409) or other failure
// leaves it open so the human can adjust the path.
export async function renameFile(toPath) {
  const from = state.selectedFilePath;
  const to = (toPath ?? "").trim();
  if (!state.selected || !from || to === "") return;
  if (to === from) {
    state.fileRenaming = false;
    return;
  }
  let res;
  try {
    res = await fetch(`/sessions/${state.selected}/file/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
  } catch {
    toast("ファイル名の変更に失敗しました");
    return;
  }
  if (!res.ok) {
    toast(res.status === 409 ? "同名のファイルが既にあります" : "ファイル名の変更に失敗しました");
    return;
  }
  state.fileRenaming = false;
  await ensureFilesLoaded(true);
  await selectFile(to);
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

// `state.ws` is the live stream for the selected session. It silently dies on
// network blips, server restarts, OS sleep/wake, or the server's idle timeout,
// and the per-30s sidebar poll does not refresh the selected session's
// reports / asking / feedback — so without a reconnect, new reports and acks
// stop reaching the detail pane until the human reloads the tab. Reconnect
// with exponential backoff; the server replays missed events from `lastSeq`,
// and the existing message handler turns those into the same refreshDetail
// calls a fresh connection would have driven.
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;

export function openWs(id) {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/sessions/${id}/stream`);
  state.ws = ws;
  ws.addEventListener("open", () => {
    wsReconnectAttempts = 0;
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
    if (ev.kind === "report_submitted" || ev.kind === "report_read" || ev.kind === "report_unread" || ev.kind === "report_deleted"
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
    // A close fired on a ws that is no longer state.ws means selectSession
    // already replaced it — don't reconnect that stale connection.
    if (state.ws !== ws) return;
    state.ws = null;
    if (state.selected !== id) return;
    const delay = Math.min(WS_RECONNECT_BASE_MS * 2 ** wsReconnectAttempts, WS_RECONNECT_MAX_MS);
    wsReconnectAttempts++;
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      if (state.selected === id && !state.ws) openWs(id);
    }, delay);
  });
}
