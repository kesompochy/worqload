// renderDetail rebuilds #detailMain — the lower part of the session detail
// pane: the pending-asking section, the active tab's content, the "Feedback
// sent" list, and the feedback/resume composer — from `state` on every change,
// re-attaching its event listeners. The tab-specific HTML comes from the
// *-view modules, the click/submit handlers from handlers.js. The header / meta
// line / tab bar above it is DetailHeader.svelte; the sidebar is
// SessionList.svelte (both mounted from main.ts off the reactive `state`).

import { $, escapeHtml, formatRelative, bindEnterToSubmit } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { state, isReportExpanded, isFeedbackExpanded } from "./state.svelte.js";
import { renderDiffHtml } from "./diff-view.js";
import { renderFilesHtml } from "./files-view.js";
import { renderEventsHtml } from "./events-view.js";
import { renderActionPanelHtml } from "./actions-view.js";
import {
  onStopAndMarkRead,
  onResume,
  onFeedback,
  onResolve,
  onResolveCommand,
  onDetailBodyClick,
  toggleActionPanel,
  runOpenAction,
  clearAnchor,
} from "./handlers.js";

// The sidebar is now SessionList.svelte (mounted from main.ts), which re-renders
// itself off the reactive `state`. This stays exported because api.js and
// handlers.js still call it as their "the session list changed" signal — those
// mutations already update `state`, so there is nothing left to do here.
export function renderSessionList() {}

// renderDetail rebuilds #detailMain, replacing #detailBody (the scroll
// container) and every row inside it — so the browser's native scroll
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
  const root = $("#detailMain");
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
         <div class="label">⚠ Waiting for you — respond below to resume</div>
         ${state.asking.map(a => {
           const body = `<div class="filename">${escapeHtml(a.filename)}</div>
             <div class="md">${renderMarkdown(a.content)}</div>`;
           const controls = typeof a.command === "string"
             ? `<textarea class="ask-answer" rows="2" placeholder="Optional reason (sent to the agent if you reject)..." style="margin-top:.4rem"></textarea>
                <div class="row" style="margin-top:.3rem">
                  <span class="spacer"></span>
                  <button class="ask-reject">Reject</button>
                  <button class="ask-approve">Approve &amp; run</button>
                </div>`
             : `<textarea class="ask-answer" rows="3" placeholder="Your answer..." style="margin-top:.4rem"></textarea>
                <div class="row" style="margin-top:.3rem">
                  <span class="spacer"></span>
                  <button class="ask-resolve">Answer</button>
                </div>`;
           return `<article data-asking="${escapeHtml(a.filename)}" style="margin-top:.6rem">${body}${controls}</article>`;
         }).join("")}
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
    ${actionBarHtml}
    ${actionPanelHtml}
    <div class="detail-body${state.activeTab === "diff" ? " diff-view" : ""}" id="detailBody">
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
  document.querySelectorAll("[data-asking]").forEach(el => {
    const filename = el.getAttribute("data-asking");
    el.querySelector(".ask-resolve")?.addEventListener("click", () => onResolve(filename, el));
    el.querySelector(".ask-approve")?.addEventListener("click", () => onResolveCommand(filename, "approve", el));
    el.querySelector(".ask-reject")?.addEventListener("click", () => onResolveCommand(filename, "reject", el));
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

// Age the Events tab's "· Ns ago" relative timestamp in place every second.
// The tab bar lives in DetailHeader.svelte, which re-renders the count and
// timestamp reactively when a new event streams into state.detail.events — but
// between events the relative label still needs to tick, and nothing changes a
// reactive dep for that, so this pokes the rendered nodes directly. (Folds into
// an $effect / time-tick $state once the Events tab itself is Svelte-migrated.)
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
