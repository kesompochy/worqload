// renderDetail rebuilds the parts of the session detail pane that are still
// vanilla: the action bar + action panel (#detailActionArea, above the scroll
// body) and the feedback/resume composer (#detailComposer, below it). The
// scroll body itself — the pending-asking section, the active tab's content,
// the "Feedback sent" list — is DetailBody.svelte (mounted into
// #detailBodyMount from main.ts); the header / meta line / tab bar above it is
// DetailHeader.svelte; the sidebar is SessionList.svelte. All three re-render
// reactively off `state`.

import { $, escapeHtml, formatRelative, bindEnterToSubmit } from "./dom.js";
import { state } from "./state.svelte.js";
import { renderActionPanelHtml } from "./actions-view.js";
import {
  onStopAndMarkRead,
  onResume,
  onFeedback,
  toggleActionPanel,
  runOpenAction,
  clearAnchor,
} from "./handlers.js";

// The sidebar is now SessionList.svelte (mounted from main.ts), which re-renders
// itself off the reactive `state`. This stays exported because api.js and
// handlers.js still call it as their "the session list changed" signal — those
// mutations already update `state`, so there is nothing left to do here.
export function renderSessionList() {}

export function renderDetail() {
  const actionArea = $("#detailActionArea");
  const composer = $("#detailComposer");
  if (!actionArea || !composer) return;
  if (!state.selected || !state.detail) {
    actionArea.innerHTML = "";
    composer.innerHTML = "";
    return;
  }
  const m = state.detail.meta;
  const isTerminal = m.status === "stopped" || m.status === "crashed";

  // preserve any in-progress feedback text across re-renders
  const preservedFeedback = ($("#feedbackInput")?.value) ?? "";
  // preserve any in-progress action-parameter input across re-renders
  const preservedActionParams = {};
  for (const el of document.querySelectorAll("[data-action-param]")) {
    preservedActionParams[el.getAttribute("data-action-param")] = el.value;
  }

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

  actionArea.innerHTML = `${actionBarHtml}${renderActionPanelHtml()}`;

  // Anchored comments target the feedback inbox; the resume composer (terminal
  // sessions) sends a plain prompt instead, so the chip is hidden there.
  const anchorChip = state.anchor && !isTerminal
    ? `<div class="anchor-chip">Re: ${escapeHtml(state.anchor.path)}:${state.anchor.lineStart}${state.anchor.lineEnd !== state.anchor.lineStart ? `-${state.anchor.lineEnd}` : ""} <button id="anchorClear" title="clear anchor">×</button></div>`
    : "";

  composer.innerHTML = `
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
  if (state.anchor && !isTerminal) $("#anchorClear")?.addEventListener("click", clearAnchor);

  if (preservedFeedback) $("#feedbackInput").value = preservedFeedback;
  for (const [name, value] of Object.entries(preservedActionParams)) {
    const el = document.getElementById(`actionParam-${name}`);
    if (el) el.value = value;
  }
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
