// renderDetail rebuilds the part of the session detail pane that is still
// vanilla: the feedback/resume composer (#detailComposer, below the scroll
// body). The action bar + action panel above the body is ActionBar.svelte
// (mounted into #detailActionArea from main.ts); the scroll body itself — the
// pending-asking section, the active tab's content, the "Feedback sent" list —
// is DetailBody.svelte (mounted into #detailBodyMount); the header / meta line
// / tab bar above it is DetailHeader.svelte; the sidebar is SessionList.svelte.
// All of those re-render reactively off `state`.

import { $, escapeHtml, bindEnterToSubmit } from "./dom.js";
import { state } from "./state.svelte.js";
import { onResume, onFeedback, clearAnchor } from "./handlers.js";

// The sidebar is now SessionList.svelte (mounted from main.ts), which re-renders
// itself off the reactive `state`. This stays exported because api.js and
// handlers.js still call it as their "the session list changed" signal — those
// mutations already update `state`, so there is nothing left to do here.
export function renderSessionList() {}

export function renderDetail() {
  const composer = $("#detailComposer");
  if (!composer) return;
  if (!state.selected || !state.detail) {
    composer.innerHTML = "";
    return;
  }
  const m = state.detail.meta;
  const isTerminal = m.status === "stopped" || m.status === "crashed";

  // preserve any in-progress feedback text across re-renders
  const preservedFeedback = ($("#feedbackInput")?.value) ?? "";

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

  const onComposerSubmit = isTerminal ? onResume : onFeedback;
  $("#feedbackForm").addEventListener("submit", e => {
    e.preventDefault();
    onComposerSubmit();
  });
  bindEnterToSubmit($("#feedbackInput"), onComposerSubmit);
  if (state.anchor && !isTerminal) $("#anchorClear")?.addEventListener("click", clearAnchor);

  if (preservedFeedback) $("#feedbackInput").value = preservedFeedback;
}
