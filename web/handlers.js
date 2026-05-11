// Every user-initiated action: switching sessions, clicking in the detail
// pane, the composer (feedback / resume), session lifecycle (stop / cancel /
// archive), gh actions, the new-session modal. Each handler mutates `state`
// and/or calls the data layer, then triggers a re-render.

import { $, toast } from "./dom.js";
import { state, isReportExpanded, isFeedbackExpanded, DIFF_EXPAND_CHUNK } from "./state.js";
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
  state.lastSeq = 0;
  state.reports = [];
  state.asking = [];
  state.detail = null;
  state.collapsedFiles = new Set();
  state.diffExpansions = new Map();
  state.reportToggle = new Map();
  state.feedbackToggle = new Map();
  state.eventToggle = new Map();
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

export async function onDiffBaseChange(value) {
  state.diffBase = value;
  await refreshDiff();
  renderDetail();
}

export async function onArchive() {
  if (!state.selected) return;
  try {
    await api("POST", `/sessions/${state.selected}/archive`, {});
    const archivedId = state.selected;
    await fetchSessions();
    // Move to first remaining session, or empty pane
    const next = state.sessions.find(s => s.id !== archivedId);
    await selectSession(next ? next.id : null);
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

export async function onStop() {
  if (!state.selected) return;
  try {
    await api("POST", `/sessions/${state.selected}/stop`, {});
    await refreshDetail();
    await fetchSessions();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

export async function onCancel() {
  if (!state.selected) return;
  if (!confirm("Cancel this session? The worktree will be REMOVED.")) return;
  try {
    await api("POST", `/sessions/${state.selected}/cancel`, {});
    await refreshDetail();
    await fetchSessions();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

export async function onResume() {
  if (!state.selected) return;
  const input = $("#feedbackInput");
  const prompt = input ? input.value.trim() : "";
  try {
    await api("POST", `/sessions/${state.selected}/resume`, prompt ? { prompt } : {});
    if (input) input.value = "";
    toast("session resumed");
    await refreshDetail();
    await fetchSessions();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

export function openModal() {
  $("#modal").classList.remove("hidden");
  $("#modalPrompt").value = "";
  $("#modalBranch").value = "";
  $("#modalBranchName").value = "";
  $("#modalPrompt").focus();
}

export function closeModal() { $("#modal").classList.add("hidden"); }

export function toggleActionPanel(actionId) {
  if (!actionId) return;
  state.openActionId = state.openActionId === actionId ? null : actionId;
  renderDetail();
  if (state.openActionId) document.querySelector(".action-panel [data-action-param]")?.focus();
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
    toast(data.ok ? `${action.label}: success` : `${action.label}: failed`);
  } catch (e) {
    state.actionResults.set(action.id, { ok: false, exitCode: null, stdout: "", stderr: "", message: e.message, ranAt: new Date().toISOString() });
    toast(`failed: ${e.message}`);
  } finally {
    renderDetail();
  }
}

export async function createSession() {
  const createBtn = $("#modalCreate");
  if (createBtn.disabled) return;
  const prompt = $("#modalPrompt").value.trim();
  if (prompt === "") { toast("prompt is required"); return; }
  const baseBranch = $("#modalBranch").value.trim();
  const branchName = $("#modalBranchName").value.trim();
  const cancelBtn = $("#modalCancel");
  createBtn.disabled = true;
  cancelBtn.disabled = true;
  createBtn.innerHTML = `<span class="spinner"></span> Creating…`;
  try {
    const body = { prompt };
    if (baseBranch) body.baseBranch = baseBranch;
    if (branchName) body.branchName = branchName;
    const { meta } = await api("POST", "/sessions", body);
    closeModal();
    await fetchSessions();
    await selectSession(meta.id);
  } catch (e) {
    toast(`failed: ${e.message}`);
  } finally {
    createBtn.disabled = false;
    cancelBtn.disabled = false;
    createBtn.textContent = "Create";
  }
}
