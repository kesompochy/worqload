// Every user-initiated action: switching sessions, clicking in the detail
// pane, the composer (feedback / resume), session lifecycle (stop / cancel /
// archive), gh actions, the new-session modal. Each handler mutates `state`
// and/or calls the data layer; the Svelte components re-render reactively.

import { $, toast } from "./dom.js";
import { state, isReportExpanded, isFeedbackExpanded, DIFF_EXPAND_CHUNK } from "./state.svelte.js";
import { parseDiffFiles, mergeLineRanges } from "./diff-view.js";
import {
  api,
  fetchSessions,
  refreshDetail,
  refreshDiff,
  ensureFilesLoaded,
  selectFile,
  openWs,
} from "./api.js";

export async function selectSession(id) {
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.selected = id;
  state.renamingSessionId = null;
  state.lastSeq = 0;
  state.reports = [];
  state.asking = [];
  state.detail = null;
  // An anchor's path resolves only inside the previous session's worktree, so
  // it must not ride along to feedback sent to the newly selected one.
  state.anchor = null;
  state.collapsedFiles = new Set();
  state.diffExpansions = new Map();
  state.reportToggle = new Map();
  state.feedbackToggle = new Map();
  state.eventToggle = new Map();
  state.tabScroll = new Map();
  state.files = [];
  state.filesLoaded = false;
  state.fileTreeCollapsed = new Set();
  state.selectedFilePath = null;
  state.fileContent = null;
  state.openActionId = null;
  state.actionRunInFlight = false;
  state.actionResults = new Map();
  if (!id) return;
  await refreshDetail();
  openWs(id);
}

export function onDetailBodyClick(e) {
  // A link inside report markdown carries target="_blank"; let the browser
  // open it natively. Intercepting the click would fall through to onLineClick,
  // which re-renders the pane and detaches the <a> before navigation, so the
  // new tab never opens.
  if (e.target.closest("a")) return;
  // The pending-asking section (DetailBody.svelte) renders its resolve buttons
  // natively; the answer textarea is read here off the enclosing article.
  const askBtn = e.target.closest(".ask-resolve, .ask-approve, .ask-reject");
  if (askBtn) {
    const article = askBtn.closest("[data-asking]");
    if (!article) return;
    const filename = article.getAttribute("data-asking");
    if (askBtn.classList.contains("ask-resolve")) onResolve(filename, article, askBtn);
    else if (askBtn.classList.contains("ask-approve")) onResolveCommand(filename, "approve", article, askBtn);
    else onResolveCommand(filename, "reject", article, askBtn);
    return;
  }
  const markBtn = e.target.closest("[data-report-mark]");
  if (markBtn) {
    e.stopPropagation();
    const filename = markBtn.getAttribute("data-report-mark");
    const to = markBtn.getAttribute("data-report-mark-to");
    onReportMark(filename, to === "read");
    return;
  }
  const reportToggle = e.target.closest("[data-report-toggle]");
  if (reportToggle) {
    const filename = reportToggle.getAttribute("data-report-toggle");
    const report = state.reports.find(r => r.filename === filename);
    const currentlyExpanded = report ? isReportExpanded(report) : true;
    // Reassign rather than mutate in place: Svelte 5's $state doesn't proxy
    // Maps, so the components only re-render when the property itself is replaced.
    state.reportToggle = new Map(state.reportToggle).set(filename, !currentlyExpanded);
    return;
  }
  const feedbackToggle = e.target.closest("[data-feedback-toggle]");
  if (feedbackToggle) {
    const filename = feedbackToggle.getAttribute("data-feedback-toggle");
    const feedback = state.feedbackHistory.find(f => f.filename === filename);
    const currentlyExpanded = feedback ? isFeedbackExpanded(feedback) : true;
    state.feedbackToggle = new Map(state.feedbackToggle).set(filename, !currentlyExpanded);
    return;
  }
  const eventToggle = e.target.closest("[data-event-toggle]");
  if (eventToggle) {
    const seq = Number(eventToggle.getAttribute("data-event-toggle"));
    state.eventToggle = new Map(state.eventToggle).set(seq, state.eventToggle.get(seq) !== true);
    return;
  }
  // The copy button lives inside the click-to-collapse diff-file header, so this
  // branch has to run before the data-diff-toggle one or the same click folds
  // the file too.
  const copyPathBtn = e.target.closest("[data-copy-path]");
  if (copyPathBtn) {
    e.stopPropagation();
    const path = copyPathBtn.getAttribute("data-copy-path");
    navigator.clipboard.writeText(path).then(() => toast("path copied")).catch(() => toast("copy failed"));
    return;
  }
  const toggle = e.target.closest("[data-diff-toggle]");
  if (toggle) {
    const path = toggle.getAttribute("data-diff-toggle");
    // Reassign rather than mutate in place: Svelte 5's $state doesn't proxy
    // Sets, so DiffView only re-derives when the property itself is replaced.
    const next = new Set(state.collapsedFiles);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    state.collapsedFiles = next;
    return;
  }
  const expandBtn = e.target.closest("[data-expand-dir]");
  if (expandBtn) {
    expandDiffGap(
      expandBtn.getAttribute("data-expand-path"),
      Number(expandBtn.getAttribute("data-expand-from")),
      Number(expandBtn.getAttribute("data-expand-to")),
      expandBtn.getAttribute("data-expand-dir"),
    );
    return;
  }
  const dirToggle = e.target.closest("[data-dir-toggle]");
  if (dirToggle) {
    const path = dirToggle.getAttribute("data-dir-toggle");
    // Reassigned wholesale, not mutated: $state doesn't proxy Set, so the
    // Files explorer only re-renders when the property itself changes.
    const next = new Set(state.fileTreeCollapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    state.fileTreeCollapsed = next;
    return;
  }
  const fileOpen = e.target.closest("[data-file-open]");
  if (fileOpen) {
    selectFile(fileOpen.getAttribute("data-file-open"));
    return;
  }
  onLineClick(e);
}

export async function onReportMark(filename, read) {
  if (!state.selected) return;
  const verb = read ? "read" : "unread";
  try {
    await api("POST", `/sessions/${state.selected}/reports/${encodeURIComponent(filename)}/${verb}`, {});
    // Drop any explicit toggle so the new default (collapsed when read,
    // expanded when unread) takes effect on the next render.
    const nextToggle = new Map(state.reportToggle);
    nextToggle.delete(filename);
    state.reportToggle = nextToggle;
    await refreshDetail();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// collapsedFiles / diffExpansions are reassigned wholesale rather than mutated
// in place: Svelte 5's $state doesn't proxy Sets/Maps, so DiffView (and the
// scroll-capture effect in DetailBody) only react when the property is replaced.
export function onExpandAllDiffFiles() {
  state.collapsedFiles = new Set();
  const expansions = new Map();
  for (const file of parseDiffFiles(state.diff)) expansions.set(file.path, [[1, Infinity]]);
  state.diffExpansions = expansions;
}

export function onCollapseAllDiffFiles() {
  const collapsed = new Set();
  for (const el of document.querySelectorAll("[data-diff-path]")) {
    const path = el.getAttribute("data-diff-path");
    if (path) collapsed.add(path);
  }
  state.collapsedFiles = collapsed;
  state.diffExpansions = new Map();
}

export function expandDiffGap(path, from, to, dir) {
  if (!path || !Number.isFinite(from) || !Number.isFinite(to)) return;
  let range;
  if (dir === "up") range = [Math.max(from, to - DIFF_EXPAND_CHUNK + 1), to];
  else if (dir === "down") range = [from, Math.min(to, from + DIFF_EXPAND_CHUNK - 1)];
  else range = [from, to];
  const existing = state.diffExpansions.get(path) || [];
  const next = new Map(state.diffExpansions);
  next.set(path, mergeLineRanges([...existing, range]));
  state.diffExpansions = next;
}

export function onLineClick(e) {
  // A drag to select text ends with a click event too. Treating it as a line
  // anchor would re-render the pane and discard the selection before the user
  // can copy it, so bail when text is selected — except on Shift+click, which
  // is the deliberate gesture for extending the anchor range.
  const selection = window.getSelection();
  if (!e.shiftKey && selection && !selection.isCollapsed) return;
  const target = e.target.closest("[data-anchor-line]");
  if (!target) return;
  const path = target.getAttribute("data-anchor-path");
  const lineStart = Number(target.getAttribute("data-anchor-line"));
  const lineEndAttr = target.getAttribute("data-anchor-line-end");
  const lineEnd = lineEndAttr !== null ? Number(lineEndAttr) : lineStart;
  if (!path || !Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) return;
  if (e.shiftKey && state.anchor && state.anchor.path === path) {
    state.anchor = {
      path,
      lineStart: Math.min(state.anchor.lineStart, lineStart),
      lineEnd: Math.max(state.anchor.lineEnd, lineEnd),
    };
  } else {
    state.anchor = { path, lineStart, lineEnd };
  }
}

export function clearAnchor() {
  state.anchor = null;
}

export async function switchTab(tab) {
  if (tab === state.activeTab) return;
  state.activeTab = tab;
  if (tab === "diff") await refreshDiff();
  if (tab === "files") await ensureFilesLoaded();
}

export async function onArchive(id = state.selected) {
  if (!id) return;
  try {
    await api("POST", `/sessions/${id}/archive`, {});
    await fetchSessions();
    // Archiving the session in the detail pane empties it — move to the first
    // session left, or an empty pane. Archiving some other card via its hover
    // button leaves the current selection (and the pane) untouched.
    if (id === state.selected) {
      const next = state.sessions.find(s => s.id !== id);
      await selectSession(next ? next.id : null);
    }
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// Disable every button in the asking article (and show "Sending…" on the one
// the human clicked) while its resolve request is in flight, so a second click
// can't fire a duplicate POST. On success refreshDetail tears the article down;
// on failure the returned restore() re-enables it for a retry.
function lockAskingArticle(articleEl, activeButton) {
  const buttons = articleEl ? [...articleEl.querySelectorAll("button")] : [];
  const activeLabel = activeButton ? activeButton.textContent : null;
  for (const b of buttons) b.disabled = true;
  if (activeButton) activeButton.textContent = "Sending…";
  return () => {
    for (const b of buttons) b.disabled = false;
    if (activeButton) activeButton.textContent = activeLabel;
  };
}

export async function onResolve(filename, articleEl, buttonEl) {
  if (!state.selected) return;
  const text = articleEl.querySelector(".ask-answer").value.trim();
  if (text === "") { toast("answer is required"); return; }
  const restore = lockAskingArticle(articleEl, buttonEl);
  try {
    await api("POST", `/sessions/${state.selected}/escalations/${encodeURIComponent(filename)}/resolve`, { content: text });
    toast("answer sent");
    await refreshDetail();
    await fetchSessions();
  } catch (e) {
    restore();
    toast(`failed: ${e.message}`);
  }
}

// Resolve a command-approval escalation: the human either approves (the server
// runs the command and feeds back its output) or rejects it, optionally with a
// reason typed into the article's textarea that's relayed to the agent.
export async function onResolveCommand(filename, decision, articleEl, buttonEl) {
  if (!state.selected) return;
  const body = { decision };
  if (decision === "reject") {
    const reason = articleEl?.querySelector(".ask-answer")?.value.trim() ?? "";
    if (reason !== "") body.content = reason;
  }
  const restore = lockAskingArticle(articleEl, buttonEl);
  try {
    const res = await api("POST", `/sessions/${state.selected}/escalations/${encodeURIComponent(filename)}/resolve`, body);
    toast(decision === "approve" ? `command ran (exit ${res.exitCode ?? "?"})` : "command rejected");
    await refreshDetail();
    await fetchSessions();
  } catch (e) {
    restore();
    toast(`failed: ${e.message}`);
  }
}

export async function onFeedback() {
  if (!state.selected) return;
  const text = $("#feedbackInput").value.trim();
  if (text === "") return;
  const body = { content: text, slug: state.anchor ? "anchored" : "feedback" };
  if (state.anchor) {
    body.anchor = {
      path: state.anchor.path,
      lineStart: state.anchor.lineStart,
      lineEnd: state.anchor.lineEnd,
    };
  }
  try {
    await api("POST", `/sessions/${state.selected}/feedback`, body);
    $("#feedbackInput").value = "";
    state.anchor = null;
    toast("feedback queued");
    await refreshDetail();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

export async function onStop(id = state.selected) {
  if (!id) return;
  try {
    await api("POST", `/sessions/${id}/stop`, {});
    if (id === state.selected) await refreshDetail();
    await fetchSessions();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// The "wrap up this session" gesture: clear every unread-report badge, then
// stop the session — the two steps the human was otherwise doing by hand
// (mark each report read, then Stop in the sidebar).
export async function onStopAndMarkRead() {
  if (!state.selected) return;
  try {
    await api("POST", `/sessions/${state.selected}/reports/read-all`, {});
    await api("POST", `/sessions/${state.selected}/stop`, {});
    await refreshDetail();
    await fetchSessions();
    toast("session stopped · all reports marked read");
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

export async function onCancel(id = state.selected) {
  if (!id) return;
  if (!confirm("Cancel this session? The worktree will be REMOVED.")) return;
  try {
    await api("POST", `/sessions/${id}/cancel`, {});
    if (id === state.selected) await refreshDetail();
    await fetchSessions();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

export async function onResume(id = state.selected) {
  if (!id) return;
  // The composer textarea holds a prompt for the session shown in the detail
  // pane; resuming a different card from its hover button carries no prompt.
  const input = id === state.selected ? $("#feedbackInput") : null;
  const prompt = input ? input.value.trim() : "";
  try {
    await api("POST", `/sessions/${id}/resume`, prompt ? { prompt } : {});
    if (input) input.value = "";
    toast("session resumed");
    if (id === state.selected) await refreshDetail();
    await fetchSessions();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// Inline rename of a session's display title (the "alias"). The sidebar/detail
// title defaults to the head of the initial prompt, which reads as the user's
// opening message and is hard to tell sessions apart by; a short alias fixes
// that. A blank value clears the alias and reinstates the prompt-head fallback.
export function onRenameStart(id) {
  if (!id) return;
  state.renamingSessionId = id;
}

export function onRenameCancel() {
  if (!state.renamingSessionId) return;
  state.renamingSessionId = null;
}

export async function onRenameCommit(id, rawValue) {
  // Guard against a second invocation: pressing Enter commits and a `blur`
  // (when the re-render removes the input, or focus moves away) would call this
  // again — by then renamingSessionId no longer matches and we no-op.
  if (state.renamingSessionId !== id) return;
  state.renamingSessionId = null;
  const title = (rawValue ?? "").trim();
  const card = state.sessions.find(s => s.id === id);
  if (title === ((card && card.title) || "")) return;
  try {
    const { meta } = await api("POST", `/sessions/${id}/title`, { title });
    if (card) card.title = meta.title;
    if (state.detail && state.detail.meta && state.detail.meta.id === id) state.detail.meta = meta;
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

export function toggleActionPanel(actionId) {
  if (!actionId) return;
  state.openActionId = state.openActionId === actionId ? null : actionId;
}

// Pulls the pull-request URL out of the create-pr run log. `gh pr create`
// prints the URL on its own line; the run log wraps it with the shell-style
// command echoes, so scan for the last GitHub-style `.../pull/<n>` URL (works
// for github.com and GHES alike).
export function extractPullRequestUrl(stdout) {
  const matches = stdout.match(/https?:\/\/\S+\/pull\/\d+/g);
  return matches ? matches[matches.length - 1] : null;
}

export async function runOpenAction() {
  const action = state.actions.find(a => a.id === state.openActionId);
  if (!action || !state.selected) return;
  const params = {};
  for (const p of action.params || []) {
    const el = document.getElementById(`actionParam-${p.name}`);
    if (el) params[p.name] = el.value;
  }
  // actionResults is reassigned wholesale rather than mutated: Svelte 5's
  // $state doesn't proxy Maps, so ActionBar only re-renders the run output
  // when the property itself is replaced. The in-flight flag drives the Run
  // button's disabled/spinner state the same way.
  state.actionRunInFlight = true;
  try {
    const res = await fetch(`/sessions/${state.selected}/actions/${encodeURIComponent(action.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params }),
    });
    const data = await res.json().catch(() => ({}));
    state.actionResults = new Map(state.actionResults).set(action.id, {
      ok: !!data.ok,
      exitCode: data.exitCode ?? null,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      message: data.message,
      ranAt: new Date().toISOString(),
    });
    if (data.ok && action.id === "create-pr") {
      const url = extractPullRequestUrl(data.stdout ?? "");
      if (url) {
        // `gh pr create` already did the work; jumping straight to the PR is
        // the next thing the user wants. Popup blockers may swallow this since
        // it fires after the fetch resolves rather than directly on the click —
        // the URL still shows in the run output below as a fallback.
        window.open(url, "_blank", "noopener");
        toast(`PR created: ${url}`);
      } else {
        toast(`${action.label}: success`);
      }
    } else {
      toast(data.ok ? `${action.label}: success` : `${action.label}: failed`);
    }
  } catch (e) {
    state.actionResults = new Map(state.actionResults).set(action.id, { ok: false, exitCode: null, stdout: "", stderr: "", message: e.message, ranAt: new Date().toISOString() });
    toast(`failed: ${e.message}`);
  } finally {
    state.actionRunInFlight = false;
  }
}

