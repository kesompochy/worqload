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
  import { onFeedback, onResume, clearAnchor, copyAnchorPermalink, removeAttachment, onComposerPaste, onComposerDrop } from "../handlers.js";

  const skillButtons = $derived(appState.actions.filter(a => a.feedbackContent));

  function fillSkillCommand(feedbackContent) {
    const input = document.getElementById("feedbackInput");
    if (!input) return;
    input.value = feedbackContent;
    input.focus();
  }

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
      <div class="anchor-chip">Re: {anchorLabel(appState.anchor)} <button type="button" title="GitHub permalink をコピー" onclick={copyAnchorPermalink}>🔗</button> <button type="button" title="clear anchor" onclick={clearAnchor}>×</button></div>
    {/if}
    {#if !isTerminal && appState.pendingAttachments.length > 0}
      <!-- Image chips queued for the next submit. The list is shared with the
           floating anchored composer; whichever submits empties it. -->
      <div class="attachment-chips">
        {#each appState.pendingAttachments as att (att.id)}
          <span class="attachment-chip" title="{att.file.name}">
            <img src={att.previewUrl} alt={att.file.name} />
            <span class="attachment-chip-name">{att.file.name}</span>
            <button type="button" title="remove" onclick={() => removeAttachment(att.id)}>×</button>
          </span>
        {/each}
      </div>
    {/if}
    <textarea
      id="feedbackInput"
      rows="3"
      placeholder={isTerminal
        ? "Instructions for the resumed session (optional — picked up via worqload feedback fetch). Enter で再開 / Shift+Enter で改行"
        : appState.anchor
          ? "Comment on the selected lines... (Enter で送信 / Shift+Enter で改行 / 画像はペースト・ドロップで添付)"
          : "Plain feedback (picked up at the agent's next turn). Click a diff, file, or report line to anchor. (Enter で送信 / Shift+Enter で改行 / 画像はペースト・ドロップで添付)"}
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => (composing = false)}
      onkeydown={(e) => onKeydown(e, isTerminal)}
      onpaste={(e) => { if (!isTerminal) onComposerPaste(e); }}
      ondragover={(e) => { if (!isTerminal) e.preventDefault(); }}
      ondrop={(e) => { if (!isTerminal) onComposerDrop(e); }}
    ></textarea>
    <div class="row">
      <span class="spacer"></span>
      <button type="submit">{isTerminal ? "Resume session" : "Send feedback"}</button>
    </div>
    {#if !isTerminal && skillButtons.length > 0}
      <div class="skill-buttons">
        {#each skillButtons as sb (sb.id)}
          <button type="button" class="skill-btn" title={sb.description || ""} onclick={() => fillSkillCommand(sb.feedbackContent)}>{sb.label}</button>
        {/each}
      </div>
    {/if}
  </form>
{/if}
