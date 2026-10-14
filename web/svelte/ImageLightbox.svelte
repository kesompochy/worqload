<script>
  // In-page zoom for image attachments (report / feedback thumbnails in any
  // .attachment-strip). A plain click on a thumbnail opens the image over the
  // page instead of following the link to a new tab; modifier / middle clicks
  // still reach the link, so "open in new tab" stays available. Clicking the
  // image toggles between fit-to-screen and natural size; clicking the
  // backdrop or pressing Escape closes.
  import { onMount } from "svelte";

  let src = $state(null);
  let alt = $state("");
  let naturalSize = $state(false);

  function close() {
    src = null;
  }

  function onDocumentClick(e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest?.(".attachment-strip a");
    if (!link) return;
    e.preventDefault();
    src = link.href;
    alt = link.title;
    naturalSize = false;
  }

  function onKeydown(e) {
    if (src && e.key === "Escape") { e.preventDefault(); close(); }
  }

  onMount(() => {
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onKeydown);
    return () => {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onKeydown);
    };
  });
</script>

{#if src}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="image-lightbox" class:natural-size={naturalSize} onclick={close}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <img
      {src}
      {alt}
      title={naturalSize ? "クリックで画面に合わせる" : "クリックで原寸表示"}
      onclick={(e) => { e.stopPropagation(); naturalSize = !naturalSize; }}
    />
  </div>
{/if}
