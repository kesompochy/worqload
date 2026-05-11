// Renders the two persistent panes: the session list (left sidebar) and the
// session detail (right). renderDetail rebuilds the detail pane from `state`
// on every change and re-attaches its event listeners; the tab-specific HTML
// comes from the *-view modules, the click/submit handlers from handlers.js.

import { $, escapeHtml, formatRelative, bindEnterToSubmit, bindInlineEdit } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { state, isReportExpanded, isFeedbackExpanded } from "./state.js";
import { renderDiffHtml } from "./diff-view.js";
import { renderFilesHtml } from "./files-view.js";
import { renderEventsHtml } from "./events-view.js";
import { renderActionPanelHtml } from "./actions-view.js";
import {
  selectSession,
  onStop,
  onStopAndMarkRead,
  onArchive,
  onCancel,
  onResume,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onFeedback,
  onResolve,
  onDetailBodyClick,
  onExpandAllDiffFiles,
  onCollapseAllDiffFiles,
  onDiffBaseChange,
  switchTab,
  toggleActionPanel,
  runOpenAction,
  clearAnchor,
} from "./handlers.js";

export function renderSessionList() {
  const root = $("#sessionList");
  // The 30s poll and live events both rebuild this list; if the user is in the
  // middle of an inline rename, carry the in-progress text (and focus) across.
  const prevRenameInput = root.querySelector(".session-rename-input");
  const renamePreserved = prevRenameInput ? prevRenameInput.value : null;
  const renameWasFocused = prevRenameInput !== null && document.activeElement === prevRenameInput;
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
    // The inline rename input only renders on the active card; guard on isActive
    // too so a stale renamingSessionId never sprouts an input on some other card.
    const isRenaming = isActive && s.id === state.renamingSessionId;
    const unread = Number(s.unreadReportCount) || 0;
    const badgeText = unread > 99 ? "99+" : String(unread);
    const badgeHtml = unread > 0
      ? `<span class="unread-badge" aria-label="${unread} unread report${unread === 1 ? "" : "s"}" title="${unread} unread report${unread === 1 ? "" : "s"}">${badgeText}</span>`
      : "";
    const statusBadge = `<span class="badge badge-${s.status}">${s.status.replace("_", " ")}</span>`;
    const titleHtml = isRenaming
      ? `<p class="title">${statusBadge}</p>
         <input class="session-rename-input" type="text" maxlength="120" placeholder="alias（空欄でプロンプト先頭）" value="${escapeHtml(s.title || "")}">`
      : `<p class="title">${statusBadge}${escapeHtml(s.title || s.prompt.slice(0, 80))}</p>`;
    // Action buttons sit on every card and are revealed on hover (CSS); the
    // active card keeps them visible always. Rename is offered only on the
    // active card because its in-place input renders there only.
    const actionsHtml = `<div class="session-card-actions">
           ${isActive && !isRenaming ? `<button class="btn-card-rename">Rename</button>` : ""}
           ${isTerminal
             ? `<button class="btn-card-resume">Resume</button>`
             : `<button class="btn-card-stop">Stop</button>`}
           <button class="btn-card-archive" ${isTerminal ? "" : "disabled"}>Archive</button>
           <button class="btn-card-cancel danger" ${isTerminal ? "disabled" : ""}>Cancel</button>
         </div>`;
    card.innerHTML = `
      <div class="session-card-main">
        ${titleHtml}
        <div class="meta">${escapeHtml(s.baseBranch)} · ${formatRelative(s.createdAt)}</div>
        ${actionsHtml}
      </div>
      ${badgeHtml}
    `;
    card.addEventListener("click", () => selectSession(s.id));
    const renameBtn = card.querySelector(".btn-card-rename");
    const resumeBtn = card.querySelector(".btn-card-resume");
    const stopBtn = card.querySelector(".btn-card-stop");
    const archiveBtn = card.querySelector(".btn-card-archive");
    const cancelBtn = card.querySelector(".btn-card-cancel");
    renameBtn?.addEventListener("click", e => { e.stopPropagation(); onRenameStart(s.id); });
    resumeBtn?.addEventListener("click", e => { e.stopPropagation(); onResume(s.id); });
    stopBtn?.addEventListener("click", e => { e.stopPropagation(); onStop(s.id); });
    archiveBtn?.addEventListener("click", e => { e.stopPropagation(); onArchive(s.id); });
    cancelBtn?.addEventListener("click", e => { e.stopPropagation(); onCancel(s.id); });
    if (isRenaming) {
      const input = card.querySelector(".session-rename-input");
      input.addEventListener("click", e => e.stopPropagation());
      input.addEventListener("blur", () => onRenameCommit(s.id, input.value));
      bindInlineEdit(input, {
        onCommit: () => onRenameCommit(s.id, input.value),
        onCancel: onRenameCancel,
      });
    }
    root.appendChild(card);
  }
  const renameInput = root.querySelector(".session-rename-input");
  if (renameInput) {
    if (renamePreserved !== null) renameInput.value = renamePreserved;
    if (renameWasFocused || renamePreserved === null) {
      renameInput.focus();
      // Fresh start (no carried text) → select all so typing replaces the old
      // alias; a mid-edit re-render → leave the caret at the end.
      if (renamePreserved === null) renameInput.select();
      else renameInput.setSelectionRange(renameInput.value.length, renameInput.value.length);
    }
  }
}

// renderDetail rebuilds the whole detail pane, replacing #detailBody (the
// scroll container) and every row inside it — so the browser's native scroll
// anchoring has nothing to correlate and the view snaps back to the top. These
// helpers carry the position across the rebuild. We anchor to the topmost row
// still reaching into the viewport (rows carry stable data-* ids) and the gap
// below the viewport top it sits at, rather than reusing scrollTop, because the
// Events and Reports lists render newest-first: a new item prepended above the
// anchor would otherwise shift everything the user is looking at. Sitting
// exactly at the top is preserved as-is so a freshly arrived item stays visible.
//
// When the active tab changes the anchor row no longer exists in the rebuilt
// DOM; instead renderDetail() stashes the outgoing tab's position in
// state.tabScroll and restores the incoming tab's stashed position, so flipping
// between tabs returns each to where it was left.
const SCROLL_ANCHOR_ATTRS = ["data-event-seq", "data-report-filename", "data-feedback-filename", "data-diff-path", "data-asking"];

// The tab whose content currently occupies #detailBody — i.e. what the next
// captureDetailScroll() will be measuring. Reset to null whenever the pane is
// torn down (empty state / session switch) so a stale position is never reused.
let renderedTab = null;

function captureDetailScroll() {
  const body = $("#detailBody");
  if (!body) return null;
  if (body.scrollTop <= 0) return { atTop: true };
  const bodyTop = body.getBoundingClientRect().top;
  for (const el of body.querySelectorAll(SCROLL_ANCHOR_ATTRS.map(a => `[${a}]`).join(","))) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= bodyTop) continue; // entirely scrolled past
    for (const attr of SCROLL_ANCHOR_ATTRS) {
      const value = el.getAttribute(attr);
      if (value) return { attr, value, offset: rect.top - bodyTop };
    }
  }
  return { scrollTop: body.scrollTop };
}

function restoreDetailScroll(saved) {
  if (!saved || saved.atTop) return;
  const body = $("#detailBody");
  if (!body) return;
  if (saved.scrollTop !== undefined) { body.scrollTop = saved.scrollTop; return; }
  const el = body.querySelector(`[${saved.attr}=${CSS.escape(saved.value)}]`);
  if (!el) return; // the anchored row is gone — leave the rebuilt pane at its top
  const offset = el.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTop += offset - saved.offset;
}

export function renderDetail() {
  const root = $("#detail");
  const savedScroll = captureDetailScroll();
  // preserve any in-progress feedback text across re-renders
  const preservedFeedback = ($("#feedbackInput")?.value) ?? "";
  // preserve any in-progress action-parameter input across re-renders
  const preservedActionParams = {};
  for (const el of document.querySelectorAll("[data-action-param]")) {
    preservedActionParams[el.getAttribute("data-action-param")] = el.value;
  }
  if (!state.selected || !state.detail) {
    root.innerHTML = `<div class="detail-empty">Select a session, or create a new one.</div>`;
    renderedTab = null;
    return;
  }
  // Switching tabs: remember where the outgoing tab was left.
  if (renderedTab !== null && renderedTab !== state.activeTab && savedScroll) {
    state.tabScroll.set(renderedTab, savedScroll);
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
              <span class="report-status ${statusLabel}" data-report-mark="${escapedFilename}" data-report-mark-to="${markTo}" title="${statusTitle}"><span class="report-status-state">${statusLabel}</span><span class="report-status-action">${markTo}?</span></span>
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
            <option value="base-branch" ${state.diffBase === "base-branch" ? "selected" : ""}>${escapeHtml(m.baseBranch)}</option>
            <option value="session-start" ${state.diffBase === "session-start" ? "selected" : ""}>session-start</option>
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

  // A client-side composite (not a server "gh action"): mark every report read,
  // then stop. Pointless once the session is already stopped/crashed, so it's
  // hidden there.
  const stopAndReadBtnHtml = isTerminal
    ? ""
    : `<button class="btn-action" data-stop-and-read title="Mark every report read, then stop the session">Stop &amp; mark all read</button>`;

  const actionBarHtml = state.actions.length > 0 || stopAndReadBtnHtml
    ? `<div class="action-bar">
         <span class="label">Actions</span>
         <div class="buttons">${stopAndReadBtnHtml}${actionButtonsHtml}</div>
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
  document.querySelector("[data-stop-and-read]")?.addEventListener("click", onStopAndMarkRead);
  document.querySelectorAll(".btn-action[data-action-id]").forEach(b => {
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
  // Re-render of the same tab: re-anchor to where it was. Tab switch: restore
  // that tab's last position (absent for a tab not yet visited → stays at top).
  restoreDetailScroll(renderedTab === state.activeTab ? savedScroll : (state.tabScroll.get(state.activeTab) ?? null));
  renderedTab = state.activeTab;
}

// Keep the Events tab's "(count) · Ns ago" label current between full
// re-renders. state.detail.events is updated on every streamed event even when
// the events tab isn't the active view, so reading it here is enough; a full
// renderDetail() would disturb scroll position and the feedback textarea.
export function refreshEventsTabLabel() {
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
