// Every user-initiated action: switching sessions, clicking in the detail
// pane, the composer (feedback / resume), session lifecycle (stop / cancel /
// archive), gh actions, the new-session modal. Each handler mutates `state`
// and/or calls the data layer, then triggers a re-render.

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
import { renderSessionList, renderDetail } from "./render.js";

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
  state.actionResults = new Map();
  renderSessionList();
  renderDetail();
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
    if (askBtn.classList.contains("ask-resolve")) onResolve(filename, article);
    else if (askBtn.classList.contains("ask-approve")) onResolveCommand(filename, "approve", article);
    else onResolveCommand(filename, "reject", article);
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
    state.reportToggle.set(filename, !currentlyExpanded);
    renderDetail();
    return;
  }
  const feedbackToggle = e.target.closest("[data-feedback-toggle]");
  if (feedbackToggle) {
    const filename = feedbackToggle.getAttribute("data-feedback-toggle");
    const feedback = state.feedbackHistory.find(f => f.filename === filename);
    const currentlyExpanded = feedback ? isFeedbackExpanded(feedback) : true;
    state.feedbackToggle.set(filename, !currentlyExpanded);
    renderDetail();
    return;
  }
  const eventToggle = e.target.closest("[data-event-toggle]");
  if (eventToggle) {
    const seq = Number(eventToggle.getAttribute("data-event-toggle"));
    state.eventToggle.set(seq, state.eventToggle.get(seq) !== true);
    renderDetail();
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
    if (state.collapsedFiles.has(path)) state.collapsedFiles.delete(path);
    else state.collapsedFiles.add(path);
    renderDetail();
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
    if (state.fileTreeCollapsed.has(path)) state.fileTreeCollapsed.delete(path);
    else state.fileTreeCollapsed.add(path);
    renderDetail();
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
    state.reportToggle.delete(filename);
    await refreshDetail();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

export function onExpandAllDiffFiles() {
  state.collapsedFiles.clear();
  for (const file of parseDiffFiles(state.diff)) {
    state.diffExpansions.set(file.path, [[1, Infinity]]);
  }
  renderDetail();
}

export function onCollapseAllDiffFiles() {
  for (const el of document.querySelectorAll("[data-diff-path]")) {
    const path = el.getAttribute("data-diff-path");
    if (path) state.collapsedFiles.add(path);
  }
  state.diffExpansions = new Map();
  renderDetail();
}

export function expandDiffGap(path, from, to, dir) {
  if (!path || !Number.isFinite(from) || !Number.isFinite(to)) return;
  let range;
  if (dir === "up") range = [Math.max(from, to - DIFF_EXPAND_CHUNK + 1), to];
  else if (dir === "down") range = [from, Math.min(to, from + DIFF_EXPAND_CHUNK - 1)];
  else range = [from, to];
  const existing = state.diffExpansions.get(path) || [];
  state.diffExpansions.set(path, mergeLineRanges([...existing, range]));
  renderDetail();
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
  renderDetail();
}

export function clearAnchor() {
  state.anchor = null;
  renderDetail();
}

export async function switchTab(tab) {
  if (tab === state.activeTab) return;
  state.activeTab = tab;
  if (tab === "diff") await refreshDiff();
  if (tab === "files") await ensureFilesLoaded();
  renderDetail();
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

export async function onResolve(filename, articleEl) {
  if (!state.selected) return;
  const text = articleEl.querySelector(".ask-answer").value.trim();
  if (text === "") { toast("answer is required"); return; }
  try {
    await api("POST", `/sessions/${state.selected}/escalations/${encodeURIComponent(filename)}/resolve`, { content: text });
    toast("answer sent");
    await refreshDetail();
    await fetchSessions();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// Resolve a command-approval escalation: the human either approves (the server
// runs the command and feeds back its output) or rejects it, optionally with a
// reason typed into the article's textarea that's relayed to the agent.
export async function onResolveCommand(filename, decision, articleEl) {
  if (!state.selected) return;
  const body = { decision };
  if (decision === "reject") {
    const reason = articleEl?.querySelector(".ask-answer")?.value.trim() ?? "";
    if (reason !== "") body.content = reason;
  }
  try {
    const res = await api("POST", `/sessions/${state.selected}/escalations/${encodeURIComponent(filename)}/resolve`, body);
    toast(decision === "approve" ? `command ran (exit ${res.exitCode ?? "?"})` : "command rejected");
    await refreshDetail();
    await fetchSessions();
  } catch (e) {
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
  renderSessionList(); // renders (and focuses) the inline input for this card
}

export function onRenameCancel() {
  if (!state.renamingSessionId) return;
  state.renamingSessionId = null;
  renderSessionList();
}

export async function onRenameCommit(id, rawValue) {
  // Guard against a second invocation: pressing Enter commits and a `blur`
  // (when the re-render removes the input, or focus moves away) would call this
  // again — by then renamingSessionId no longer matches and we no-op.
  if (state.renamingSessionId !== id) return;
  state.renamingSessionId = null;
  const title = (rawValue ?? "").trim();
  const card = state.sessions.find(s => s.id === id);
  if (title === ((card && card.title) || "")) { renderSessionList(); return; }
  try {
    const { meta } = await api("POST", `/sessions/${id}/title`, { title });
    if (card) card.title = meta.title;
    if (state.detail && state.detail.meta && state.detail.meta.id === id) state.detail.meta = meta;
    renderSessionList();
    renderDetail();
  } catch (e) {
    renderSessionList();
    toast(`failed: ${e.message}`);
  }
}

export function toggleActionPanel(actionId) {
  if (!actionId) return;
  state.openActionId = state.openActionId === actionId ? null : actionId;
  renderDetail();
  if (state.openActionId) document.querySelector(".action-panel [data-action-param]")?.focus();
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
  const runBtn = document.querySelector("[data-action-panel-run]");
  if (runBtn) { runBtn.disabled = true; runBtn.innerHTML = `<span class="spinner"></span> Running…`; }
  try {
    const res = await fetch(`/sessions/${state.selected}/actions/${encodeURIComponent(action.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params }),
    });
    const data = await res.json().catch(() => ({}));
    state.actionResults.set(action.id, {
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
    state.actionResults.set(action.id, { ok: false, exitCode: null, stdout: "", stderr: "", message: e.message, ranAt: new Date().toISOString() });
    toast(`failed: ${e.message}`);
  } finally {
    renderDetail();
  }
}

