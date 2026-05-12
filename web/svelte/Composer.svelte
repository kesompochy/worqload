<script>
  // The detail pane's bottom composer: the feedback form for live sessions and
  // the resume-prompt form for terminal ones, plus the anchor chip when a diff/
  // file/report line is selected. Mounted into #detailComposer from main.ts;
  // renders nothing until a session with loaded detail is selected. Reads the
  // reactive `appState`, so it re-renders when the selected session, its status,
  // or the anchor changes — the textarea node persists across those updates, so
  // in-progress text survives without a manual save/restore.
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState, anchorLabel } from "../state.svelte.js";
  import { onFeedback, onResume, clearAnchor } from "../handlers.js";

  // Tracked across the textarea's keydowns so a confirming Enter mid-IME
  // composition doesn't also submit (same guard as dom.js's bindInlineEdit).
  let composing = $state(false);

  function submit(isTerminal) {
    if (isTerminal) onResume();
    else onFeedback();
  }

  function onKeydown(event, isTerminal) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (composing || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit(isTerminal);
  }

  // onFeedback/onResume read the textarea via getElementById("feedbackInput"),
  // so it stays an uncontrolled input keyed by that id rather than bind:value.
</script>

{#if appState.selected && appState.detail}
  {@const status = appState.detail.meta.status}
  {@const isTerminal = status === "stopped" || status === "crashed"}
  <form
    class="feedback-form"
    onsubmit={(e) => { e.preventDefault(); submit(isTerminal); }}
  >
    {#if appState.anchor && !isTerminal}
      <!-- Anchored comments target the feedback inbox; the resume composer
           (terminal sessions) sends a plain prompt, so the chip is hidden there. -->
      <div class="anchor-chip">Re: {anchorLabel(appState.anchor)} <button type="button" title="clear anchor" onclick={clearAnchor}>×</button></div>
    {/if}
    <textarea
      id="feedbackInput"
      rows="3"
      placeholder={isTerminal
        ? "Instructions for the resumed session (optional — picked up via worqload feedback fetch). Enter で再開 / Shift+Enter で改行"
        : appState.anchor
          ? "Comment on the selected lines... (Enter で送信 / Shift+Enter で改行)"
          : "Plain feedback (picked up at the agent's next turn). Click a diff, file, or report line to anchor. (Enter で送信 / Shift+Enter で改行)"}
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => (composing = false)}
      onkeydown={(e) => onKeydown(e, isTerminal)}
    ></textarea>
    <div class="row">
      <span class="spacer"></span>
      <button type="submit">{isTerminal ? "Resume session" : "Send feedback"}</button>
    </div>
  </form>
{/if}
