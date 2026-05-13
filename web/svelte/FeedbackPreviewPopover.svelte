<script>
  // The floating preview for an anchored-feedback pin. Opened by handlers.js
  // (openFeedbackPreview) when the cursor enters a [data-feedback-preview] pin
  // on a diff/file line or a report-markdown block; it sets appState.feedbackPreview
  // to { entries, rect }. Each entry pairs a sent feedback with the reports
  // written in reply to it; both bodies are rendered here so the human can read
  // them without leaving the diff/file/report they were looking at. Mounted on
  // document.body (from main.ts) so it floats over the layout, positioned just
  // below the pin. Clicking a filename header jumps to that card in the
  // Feedbacks / Reports tab; leaving the popover (or scrolling, or Escape)
  // closes it.
  // (`state` is imported as `appState`: a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState, anchorLabel } from "../state.svelte.js";
  import { renderMarkdown } from "../markdown.js";
  import {
    gotoArticle,
    closeFeedbackPreview,
    cancelFeedbackPreviewClose,
    scheduleFeedbackPreviewClose,
  } from "../handlers.js";

  const preview = $derived(appState.feedbackPreview);

  $effect(() => {
    if (!preview) return;
    const onKeydown = (e) => { if (e.key === "Escape") { e.preventDefault(); closeFeedbackPreview(); } };
    // Fixed to the pin's position, so any scroll of the page (e.g. the detail
    // body) leaves it stale — close it. Scrolling inside the popover's own
    // overflow must not.
    const onScroll = (e) => { if (!e.target?.closest?.(".feedback-preview-popover")) closeFeedbackPreview(); };
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("scroll", onScroll, true);
    };
  });

  const POPOVER_WIDTH = 380;
  const popoverStyle = $derived.by(() => {
    const r = preview?.rect;
    if (!r) return "";
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 8));
    const roomBelow = window.innerHeight - r.bottom;
    return roomBelow < 240 && r.top > roomBelow
      ? `left:${left}px; bottom:${Math.round(window.innerHeight - r.top + 2)}px`
      : `left:${left}px; top:${Math.round(r.bottom + 2)}px`;
  });

  function openFeedbackCard(filename) {
    closeFeedbackPreview();
    gotoArticle("feedback", filename);
  }
  function openReportCard(filename) {
    closeFeedbackPreview();
    gotoArticle("reports", filename);
  }
</script>

{#if preview}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="feedback-preview-popover"
    style={popoverStyle}
    onmouseenter={cancelFeedbackPreviewClose}
    onmouseleave={scheduleFeedbackPreviewClose}
  >
    {#each preview.entries as entry (entry.feedback.filename)}
      <div class="fb-preview-entry">
        <button type="button" class="fb-preview-title" onclick={() => openFeedbackCard(entry.feedback.filename)} title="Feedbacks タブで開く">
          💬 {entry.feedback.filename}{#if entry.feedback.anchor}<span class="fb-preview-anchor"> · {anchorLabel(entry.feedback.anchor)}</span>{/if}
        </button>
        <div class="md fb-preview-md">{@html renderMarkdown(entry.feedback.content)}</div>
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
