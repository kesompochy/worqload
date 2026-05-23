<script>
  // The on-cursor pin + floating preview for anchored feedback. A line/block on
  // the diff/file/report carries `[data-feedback-preview]` (drawn as a left
  // stripe); the already-visible stripe is the "there's a comment here" cue, so
  // hovering it just surfaces a small 💬 pin where the cursor first entered
  // (handlers.js sets appState.feedbackPinAt = { filenames, x, y }). Hovering
  // (or tapping) that pin opens the popover with the feedback bodies and the
  // reports written in reply, so the human can read the thread without leaving
  // the code they're looking at. Mounted on document.body (from main.ts) so both
  // float over the layout. Clicking a filename header jumps to that card in the
  // Feedbacks / Reports tab; leaving everything (or scrolling, or Escape) hides it.
  // (`state` is imported as `appState`: a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState, anchorLabel, feedbackPreviewEntries } from "../state.svelte.js";
  import { renderMarkdown } from "../markdown.js";
  import {
    gotoArticle,
    hideFeedbackPin,
    cancelFeedbackPinHide,
    scheduleFeedbackPinHide,
  } from "../handlers.js";

  const pin = $derived(appState.feedbackPinAt);
  const entries = $derived(pin ? feedbackPreviewEntries(pin.filenames) : []);
  const count = $derived(pin?.filenames.length ?? 0);

  let pinEl = $state();
  let popoverOpen = $state(false);
  let popoverAnchorRect = $state(null);

  // A new pin (or the pin going away) starts with the popover closed; it opens
  // only when the pin itself is hovered/tapped.
  $effect(() => { void pin?.key; popoverOpen = false; });

  $effect(() => {
    if (!pin) return;
    const onKeydown = (e) => { if (e.key === "Escape") { e.preventDefault(); hideFeedbackPin(); } };
    // Pinned to a captured viewport position, so any scroll leaves it stale.
    // Scrolling inside the popover's own overflow must not hide it.
    const onScroll = (e) => { if (!e.target?.closest?.(".feedback-preview-popover")) hideFeedbackPin(); };
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("scroll", onScroll, true);
    };
  });

  const PIN_OFFSET = 6;   // nudge the pin off the cursor so it doesn't open the popover the instant it appears
  const PIN_BOX = 24;
  const pinStyle = $derived.by(() => {
    if (!pin) return "";
    const left = Math.min(pin.x + PIN_OFFSET, window.innerWidth - PIN_BOX - 4);
    const top = Math.min(pin.y + PIN_OFFSET, window.innerHeight - PIN_BOX - 4);
    return `left:${Math.round(left)}px; top:${Math.round(top)}px`;
  });

  const POPOVER_WIDTH = 380;
  const popoverStyle = $derived.by(() => {
    const r = popoverAnchorRect;
    if (!r) return "";
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 8));
    const roomBelow = window.innerHeight - r.bottom;
    return roomBelow < 180 && r.top > roomBelow
      ? `left:${left}px; bottom:${Math.round(window.innerHeight - r.top + 4)}px`
      : `left:${left}px; top:${Math.round(r.bottom + 4)}px`;
  });

  function openPopover() {
    cancelFeedbackPinHide();
    if (pinEl) popoverAnchorRect = pinEl.getBoundingClientRect();
    popoverOpen = true;
  }
  function openFeedbackCard(filename) { hideFeedbackPin(); gotoArticle("feedback", filename); }
  function openReportCard(filename) { hideFeedbackPin(); gotoArticle("reports", filename); }
</script>

{#if pin && entries.length > 0}
  <button
    type="button"
    class="feedback-anchor-pin"
    bind:this={pinEl}
    style={pinStyle}
    onmouseenter={openPopover}
    onmouseleave={scheduleFeedbackPinHide}
    onclick={openPopover}
  >💬{#if count > 1}<span class="feedback-anchor-count">{count}</span>{/if}</button>

  {#if popoverOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="feedback-preview-popover"
      style={popoverStyle}
      onmouseenter={cancelFeedbackPinHide}
      onmouseleave={scheduleFeedbackPinHide}
    >
      {#each entries as entry (entry.feedback.filename)}
        <div class="fb-preview-entry">
          <button type="button" class="fb-preview-title" onclick={() => openFeedbackCard(entry.feedback.filename)} title="Feedbacks タブで開く">
            💬 {entry.feedback.filename}{#if entry.feedback.anchor}<span class="fb-preview-anchor"> · {anchorLabel(entry.feedback.anchor)}</span>{/if}
          </button>
          <div class="md fb-preview-md">{@html renderMarkdown(entry.feedback.content)}</div>
          {#if entry.feedback.attachments && entry.feedback.attachments.length > 0}
            <div class="attachment-strip">
              {#each entry.feedback.attachments as name (name)}
                {@const url = `/sessions/${appState.selected}/feedback/${encodeURIComponent(entry.feedback.filename)}/attachments/${encodeURIComponent(name)}`}
                <a href={url} target="_blank" rel="noopener" title={name}>
                  <img class="attachment-thumb" src={url} alt={name} />
                </a>
              {/each}
            </div>
          {/if}
          {#each entry.replies as reply (reply.filename)}
            <button type="button" class="fb-preview-title fb-preview-reply" onclick={() => openReportCard(reply.filename)} title="Reports タブで開く">
              ↩ {reply.filename}
            </button>
            <div class="md fb-preview-md">{@html renderMarkdown(reply.content)}</div>
          {/each}
          {#if entry.replies.length === 0}
            <div class="fb-preview-noreply">返信レポートはまだありません</div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
{/if}
