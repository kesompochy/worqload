import { renderMarkdown } from "./markdown.js";
import { notificationForEvent, notificationsFromSessionPoll } from "./notifications.js";
import { $, toast, bindEnterToSubmit, escapeHtml, formatRelative } from "./dom.js";
import { state, isReportExpanded, isFeedbackExpanded } from "./state.js";
import { renderDiffHtml, parseDiffFiles, mergeLineRanges } from "./diff-view.js";
import { renderFilesHtml } from "./files-view.js";
import { renderActionPanelHtml } from "./actions-view.js";

// Desktop notifications for new reports and escalations. The preference is a
// localStorage flag; notifications fire only when it's on AND the browser has
// granted permission. Default-on once permission is granted, so the bell is a
// single toggle rather than a two-step opt-in.
const NOTIFY_PREF_KEY = "worqload:notifications";
const notify = {
  supported: typeof window !== "undefined" && "Notification" in window,
  get permission() { return this.supported ? Notification.permission : "unsupported"; },
  prefOn() { return localStorage.getItem(NOTIFY_PREF_KEY) !== "off"; },
  setPref(on) { localStorage.setItem(NOTIFY_PREF_KEY, on ? "on" : "off"); },
  active() { return this.supported && this.permission === "granted" && this.prefOn(); },
};

function fireNotification({ title, body, tag, sessionId }) {
  if (!notify.active()) return;
  let n;
  try { n = new Notification(title, { body, tag }); } catch { return; }
  n.onclick = () => {
    window.focus();
    if (sessionId && sessionId !== state.selected) selectSession(sessionId);
    n.close();
  };
}

function syncNotifyButton() {
  const btn = $("#btnNotify");
  if (!btn) return;
  if (!notify.supported) { btn.style.display = "none"; return; }
  const p = notify.permission;
  if (p === "granted" && notify.prefOn()) {
    btn.textContent = "🔔";
    btn.className = "btn-notify on";
    btn.title = "Desktop notifications: on (reports & escalations) — click to mute";
  } else if (p === "denied") {
    btn.textContent = "🔕";
    btn.className = "btn-notify off";
    btn.title = "Desktop notifications blocked in browser settings";
  } else {
    btn.textContent = "🔕";
    btn.className = "btn-notify off";
    btn.title = p === "granted"
      ? "Desktop notifications: off — click to enable"
      : "Click to enable desktop notifications";
  }
}

async function onNotifyClick() {
  if (!notify.supported) return;
  const p = notify.permission;
  if (p === "denied") { toast("Notifications are blocked — enable them in your browser settings"); return; }
  if (p === "default") {
    let result;
    try { result = await Notification.requestPermission(); } catch { result = notify.permission; }
    if (result === "granted") { notify.setPref(true); toast("Desktop notifications on"); }
    else if (result === "denied") { toast("Notifications denied"); }
    syncNotifyButton();
    return;
  }
  const next = !notify.prefOn();
  notify.setPref(next);
  toast(next ? "Desktop notifications on" : "Desktop notifications muted");
  syncNotifyButton();
}

async function api(method, path, body) {
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchSessions() {
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
  renderSessionList();
}

async function fetchActions() {
  try {
    const { actions } = await api("GET", "/actions");
    state.actions = actions;
  } catch {
    state.actions = [];
  }
}

async function fetchMeta() {
  try {
    const meta = await api("GET", "/meta");
    applyMeta(meta);
  } catch {
    // server didn't expose /meta yet; keep defaults
  }
}

function applyMeta({ repoDir, repoName }) {
  const name = repoName || "worqload";
  document.title = `${name} · worqload`;
  const repoEl = document.getElementById("repoName");
  if (repoEl) {
    repoEl.textContent = name;
    repoEl.title = repoDir || name;
  }
  const titleEl = document.getElementById("sidebarTitle");
  if (titleEl) titleEl.title = repoDir || name;
}

async function selectSession(id) {
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

async function refreshDetail() {
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
  renderDetail();
}

async function ensureFilesLoaded(force = false) {
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

async function selectFile(path) {
  if (!state.selected || !path) return;
  state.selectedFilePath = path;
  state.fileContent = { path, loading: true };
  renderDetail();
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
    renderDetail();
  }
}

async function refreshDiff() {
  if (!state.selected) return;
  let next = "";
  try {
    const res = await fetch(`/sessions/${state.selected}/diff?base=${state.diffBase}`);
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

function openWs(id) {
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
    if (state.activeTab === "events") renderDetail();
    // Keep the open action panel's "last run" view current (a run may have been
    // triggered from another browser view).
    else if (ev.kind === "action_invoked" && state.openActionId) renderDetail();
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

function renderSessionList() {
  const root = $("#sessionList");
  if (state.sessions.length === 0) {
    root.innerHTML = `<div style="padding:1rem; color:var(--text-dim)">No sessions yet.</div>`;
    return;
  }
  root.innerHTML = "";
  for (const s of state.sessions) {
    const card = document.createElement("div");
    const isActive = s.id === state.selected;
    card.className = "session-card" + (isActive ? " active" : "");
    const isTerminal = s.status === "stopped" || s.status === "crashed";
    const unread = Number(s.unreadReportCount) || 0;
    const badgeText = unread > 99 ? "99+" : String(unread);
    const badgeHtml = unread > 0
      ? `<span class="unread-badge" aria-label="${unread} unread report${unread === 1 ? "" : "s"}" title="${unread} unread report${unread === 1 ? "" : "s"}">${badgeText}</span>`
      : "";
    const actionsHtml = isActive
      ? `<div class="session-card-actions">
           <button class="btn-card-stop" ${isTerminal ? "disabled" : ""}>Stop</button>
           <button class="btn-card-archive" ${isTerminal ? "" : "disabled"}>Archive</button>
           <button class="btn-card-cancel danger" ${isTerminal ? "disabled" : ""}>Cancel</button>
         </div>`
      : "";
    card.innerHTML = `
      <div class="session-card-main">
        <p class="title"><span class="badge badge-${s.status}">${s.status.replace("_", " ")}</span>${escapeHtml(s.title || s.prompt.slice(0, 80))}</p>
        <div class="meta">${escapeHtml(s.baseBranch)} · ${formatRelative(s.createdAt)}</div>
        ${actionsHtml}
      </div>
      ${badgeHtml}
    `;
    card.addEventListener("click", () => selectSession(s.id));
    if (isActive) {
      const stopBtn = card.querySelector(".btn-card-stop");
      const archiveBtn = card.querySelector(".btn-card-archive");
      const cancelBtn = card.querySelector(".btn-card-cancel");
      stopBtn?.addEventListener("click", e => { e.stopPropagation(); onStop(); });
      archiveBtn?.addEventListener("click", e => { e.stopPropagation(); onArchive(); });
      cancelBtn?.addEventListener("click", e => { e.stopPropagation(); onCancel(); });
    }
    root.appendChild(card);
  }
}

function renderDetail() {
  const root = $("#detail");
  // preserve any in-progress feedback text across re-renders
  const preservedFeedback = ($("#feedbackInput")?.value) ?? "";
  // preserve any in-progress action-parameter input across re-renders
  const preservedActionParams = {};
  for (const el of document.querySelectorAll("[data-action-param]")) {
    preservedActionParams[el.getAttribute("data-action-param")] = el.value;
  }
  if (!state.selected || !state.detail) {
    root.innerHTML = `<div class="detail-empty">Select a session, or create a new one.</div>`;
    return;
  }
  const m = state.detail.meta;
  const askingHtml = state.asking.length > 0
    ? `<section class="asking">
         <div class="label">⚠ Question pending — answer below to resume</div>
         ${state.asking.map(a => `
           <article data-asking="${escapeHtml(a.filename)}" style="margin-top:.6rem">
             <div class="filename">${escapeHtml(a.filename)}</div>
             <div class="md">${renderMarkdown(a.content)}</div>
             <textarea class="ask-answer" rows="3" placeholder="Your answer..." style="margin-top:.4rem"></textarea>
             <div class="row" style="margin-top:.3rem">
               <span class="spacer"></span>
               <button class="ask-resolve">Answer</button>
             </div>
           </article>
         `).join("")}
       </section>`
    : "";
  const reportsHtml = state.reports.length > 0
    ? state.reports.slice().reverse().map(r => {
        const path = `./.worqload-reports/${r.filename}`;
        const body = renderMarkdown(r.content, { anchorPath: path, anchor: state.anchor });
        const expanded = isReportExpanded(r);
        const statusLabel = r.read ? "read" : "unread";
        const markTo = r.read ? "unread" : "read";
        const statusTitle = r.read ? "クリックで未読にする" : "クリックで既読にする";
        const escapedFilename = escapeHtml(r.filename);
        return `
          <article class="report ${r.read ? "" : "unread"} ${expanded ? "" : "collapsed"}" data-report-filename="${escapedFilename}">
            <div class="report-header" data-report-toggle="${escapedFilename}">
              <span class="report-chevron">▾</span>
              <span class="report-filename">${escapedFilename}</span>
              <span class="report-status ${statusLabel}" data-report-mark="${escapedFilename}" data-report-mark-to="${markTo}" title="${statusTitle}">${statusLabel}</span>
            </div>
            <div class="report-body">
              <div class="md">${body}</div>
            </div>
          </article>
        `;
      }).join("")
    : `<div class="report-empty">No reports yet. The agent submits reports at progress checkpoints.</div>`;

  const feedbackHtml = state.feedbackHistory.length > 0
    ? state.feedbackHistory.map(f => {
        const expanded = isFeedbackExpanded(f);
        const escapedFilename = escapeHtml(f.filename);
        const statusBadge = f.status === "unread" ? "waiting_human" : "stopped";
        return `
          <article class="report ${expanded ? "" : "collapsed"}" data-feedback-filename="${escapedFilename}">
            <div class="report-header" data-feedback-toggle="${escapedFilename}">
              <span class="report-chevron">▾</span>
              <span class="report-filename">${escapedFilename}</span>
              <span class="badge badge-${statusBadge}">${f.status}</span>
            </div>
            <div class="report-body">
              <div class="md">${renderMarkdown(f.content)}</div>
            </div>
          </article>
        `;
      }).join("")
    : "";

  const isTerminal = m.status === "stopped" || m.status === "crashed";

  const eventCount = state.detail.events?.length ?? 0;
  const lastEvent = eventCount > 0 ? state.detail.events[eventCount - 1] : null;
  const tabsHtml = `
    <div class="tabs">
      <button class="tab-btn ${state.activeTab === "reports" ? "active" : ""}" data-tab="reports">Reports</button>
      <button class="tab-btn ${state.activeTab === "diff" ? "active" : ""}" data-tab="diff">Diff</button>
      <button class="tab-btn ${state.activeTab === "files" ? "active" : ""}" data-tab="files">Files</button>
      <button class="tab-btn ${state.activeTab === "events" ? "active" : ""}" data-tab="events">Events <span class="tab-count">(${eventCount})</span><span class="tab-event-age"${lastEvent ? "" : ` style="display:none"`}>${lastEvent ? `· ${formatRelative(lastEvent.timestamp)}` : ""}</span></button>
      ${state.activeTab === "diff" ? `
        <span class="diff-base-toggle">
          <button id="btnExpandAll" type="button" class="diff-tool-btn">Expand all</button>
          <button id="btnCollapseAll" type="button" class="diff-tool-btn">Collapse all</button>
          base:
          <select id="diffBaseSel" style="background:transparent;border:1px solid var(--border);color:var(--text);padding:.1rem .3rem;border-radius:3px">
            <option value="session-start" ${state.diffBase === "session-start" ? "selected" : ""}>session-start</option>
            <option value="base-branch" ${state.diffBase === "base-branch" ? "selected" : ""}>${escapeHtml(m.baseBranch)}</option>
          </select>
        </span>
      ` : ""}
    </div>
  `;

  const tabContent = state.activeTab === "diff" ? renderDiffHtml()
    : state.activeTab === "files" ? renderFilesHtml()
    : state.activeTab === "events" ? renderEventsHtml()
    : reportsHtml;

  // Anchored comments target the feedback inbox; the resume composer (terminal
  // sessions) sends a plain prompt instead, so the chip is hidden there.
  const anchorChip = state.anchor && !isTerminal
    ? `<div class="anchor-chip">Re: ${escapeHtml(state.anchor.path)}:${state.anchor.lineStart}${state.anchor.lineEnd !== state.anchor.lineStart ? `-${state.anchor.lineEnd}` : ""} <button id="anchorClear" title="clear anchor">×</button></div>`
    : "";

  const actionButtonsHtml = state.actions.map(a => `
    <button class="btn-action ${state.openActionId === a.id ? "open" : ""}" data-action-id="${escapeHtml(a.id)}" title="${escapeHtml(a.description || "")}">${escapeHtml(a.label)}</button>
  `).join("");

  const actionBarHtml = state.actions.length > 0
    ? `<div class="action-bar">
         <span class="label">Actions</span>
         <div class="buttons">${actionButtonsHtml}</div>
       </div>`
    : "";

  const actionPanelHtml = renderActionPanelHtml();

  root.innerHTML = `
    <div class="detail-header">
      <div class="title"><span class="badge badge-${m.status}">${m.status.replace("_", " ")}</span>${escapeHtml(m.title || m.prompt.slice(0, 100))}</div>
    </div>
    <div class="detail-meta">
      base: <code>${escapeHtml(m.baseBranch)}</code>
      ${m.branchName ? `· branch: <code>${escapeHtml(m.branchName)}</code>` : ""}
      · started ${formatRelative(m.createdAt)}
      ${m.endedAt ? ` · ended ${formatRelative(m.endedAt)}` : ""}
      · worktree: <code>${escapeHtml(m.worktreePath)}</code>
    </div>
    ${actionBarHtml}
    ${actionPanelHtml}
    ${tabsHtml}
    <div class="detail-body" id="detailBody">
      ${askingHtml}
      ${tabContent}
      ${feedbackHtml ? `<section><h2>Feedback sent</h2>${feedbackHtml}</section>` : ""}
    </div>
    <form class="feedback-form" id="feedbackForm">
      ${anchorChip}
      <textarea id="feedbackInput" placeholder="${
        isTerminal
          ? "Instructions for the resumed session (optional — picked up via worqload feedback fetch). Enter で再開 / Shift+Enter で改行"
          : state.anchor
            ? "Comment on the selected lines... (Enter で送信 / Shift+Enter で改行)"
            : "Plain feedback (picked up at the agent's next turn). Click a diff, file, or report line to anchor. (Enter で送信 / Shift+Enter で改行)"
      }" rows="3"></textarea>
      <div class="row">
        <span class="spacer"></span>
        <button type="submit">${isTerminal ? "Resume session" : "Send feedback"}</button>
      </div>
    </form>
  `;
  document.querySelectorAll(".btn-action").forEach(b => {
    b.addEventListener("click", () => toggleActionPanel(b.getAttribute("data-action-id")));
  });
  const actionCloseBtn = document.querySelector("[data-action-panel-close]");
  if (actionCloseBtn) actionCloseBtn.addEventListener("click", () => toggleActionPanel(state.openActionId));
  const actionRunBtn = document.querySelector("[data-action-panel-run]");
  if (actionRunBtn) actionRunBtn.addEventListener("click", runOpenAction);
  const onComposerSubmit = isTerminal ? onResume : onFeedback;
  $("#feedbackForm").addEventListener("submit", e => {
    e.preventDefault();
    onComposerSubmit();
  });
  bindEnterToSubmit($("#feedbackInput"), onComposerSubmit);
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.addEventListener("click", () => switchTab(b.getAttribute("data-tab")));
  });
  const baseSel = document.getElementById("diffBaseSel");
  if (baseSel) baseSel.addEventListener("change", e => onDiffBaseChange(e.target.value));
  const btnExpandAll = document.getElementById("btnExpandAll");
  if (btnExpandAll) btnExpandAll.addEventListener("click", onExpandAllDiffFiles);
  const btnCollapseAll = document.getElementById("btnCollapseAll");
  if (btnCollapseAll) btnCollapseAll.addEventListener("click", onCollapseAllDiffFiles);
  document.querySelectorAll("[data-asking]").forEach(el => {
    const filename = el.getAttribute("data-asking");
    el.querySelector(".ask-resolve").addEventListener("click", () => onResolve(filename, el));
  });
  $("#detailBody").addEventListener("click", onDetailBodyClick);
  if (state.anchor) $("#anchorClear").addEventListener("click", clearAnchor);
  if (preservedFeedback) $("#feedbackInput").value = preservedFeedback;
  for (const [name, value] of Object.entries(preservedActionParams)) {
    const el = document.getElementById(`actionParam-${name}`);
    if (el) el.value = value;
  }
}

function onDetailBodyClick(e) {
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

async function onReportMark(filename, read) {
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

function onExpandAllDiffFiles() {
  state.collapsedFiles.clear();
  for (const file of parseDiffFiles(state.diff)) {
    state.diffExpansions.set(file.path, [[1, Infinity]]);
  }
  renderDetail();
}

function onCollapseAllDiffFiles() {
  for (const el of document.querySelectorAll("[data-diff-path]")) {
    const path = el.getAttribute("data-diff-path");
    if (path) state.collapsedFiles.add(path);
  }
  state.diffExpansions = new Map();
  renderDetail();
}

function expandDiffGap(path, from, to, dir) {
  if (!path || !Number.isFinite(from) || !Number.isFinite(to)) return;
  let range;
  if (dir === "up") range = [Math.max(from, to - DIFF_EXPAND_CHUNK + 1), to];
  else if (dir === "down") range = [from, Math.min(to, from + DIFF_EXPAND_CHUNK - 1)];
  else range = [from, to];
  const existing = state.diffExpansions.get(path) || [];
  state.diffExpansions.set(path, mergeLineRanges([...existing, range]));
  renderDetail();
}

function onLineClick(e) {
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

function clearAnchor() {
  state.anchor = null;
  renderDetail();
}

async function switchTab(tab) {
  if (tab === state.activeTab) return;
  state.activeTab = tab;
  if (tab === "diff") await refreshDiff();
  if (tab === "files") await ensureFilesLoaded();
  renderDetail();
}

async function onDiffBaseChange(value) {
  state.diffBase = value;
  await refreshDiff();
  renderDetail();
}

// Keep the Events tab's "(count) · Ns ago" label current between full
// re-renders. state.detail.events is updated on every streamed event even when
// the events tab isn't the active view, so reading it here is enough; a full
// renderDetail() would disturb scroll position and the feedback textarea.
function refreshEventsTabLabel() {
  const btn = document.querySelector('.tab-btn[data-tab="events"]');
  if (!btn) return;
  const events = state.detail?.events ?? [];
  const countEl = btn.querySelector(".tab-count");
  const ageEl = btn.querySelector(".tab-event-age");
  if (countEl) countEl.textContent = `(${events.length})`;
  if (ageEl) {
    if (events.length > 0) {
      ageEl.textContent = `· ${formatRelative(events[events.length - 1].timestamp)}`;
      ageEl.style.display = "";
    } else {
      ageEl.style.display = "none";
    }
  }
}

function renderEventsHtml() {
  const events = state.detail?.events ?? [];
  if (events.length === 0) {
    return `<div class="diff-empty">No events yet.</div>`;
  }
  return events.slice().reverse().map(e => {
    const payload = JSON.stringify(e.payload);
    const truncated = payload.length > 400 ? payload.slice(0, 400) + " …" : payload;
    return `
      <div class="event-row" data-event-seq="${e.seq}">
        <span class="event-seq">${e.seq}</span>
        <span class="event-kind">${escapeHtml(e.kind)}</span>
        <span class="event-ts">${formatRelative(e.timestamp)}</span>
        <span class="event-payload">${escapeHtml(truncated)}</span>
      </div>
    `;
  }).join("");
}

async function onArchive() {
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

async function onResolve(filename, articleEl) {
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

async function onFeedback() {
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

async function onStop() {
  if (!state.selected) return;
  if (!confirm("Stop this session? The worktree is preserved.")) return;
  try {
    await api("POST", `/sessions/${state.selected}/stop`, {});
    await refreshDetail();
    await fetchSessions();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

async function onCancel() {
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

async function onResume() {
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

function openModal() {
  $("#modal").classList.remove("hidden");
  $("#modalPrompt").value = "";
  $("#modalBranch").value = "";
  $("#modalBranchName").value = "";
  $("#modalPrompt").focus();
}
function closeModal() { $("#modal").classList.add("hidden"); }

function toggleActionPanel(actionId) {
  if (!actionId) return;
  state.openActionId = state.openActionId === actionId ? null : actionId;
  renderDetail();
  if (state.openActionId) document.querySelector(".action-panel [data-action-param]")?.focus();
}

async function runOpenAction() {
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

async function createSession() {
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
