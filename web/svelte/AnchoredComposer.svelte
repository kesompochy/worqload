<script>
  // A small floating feedback composer that surfaces next to an anchored line
  // or block while `state.anchor` is set. The bottom-fixed composer
  // (Composer.svelte) stays as-is; this one removes the cursor-travel back to
  // the bottom of the pane after anchoring. Mounted on document.body (from
  // main.ts) so it floats over the detail pane.
  //
  // Position: anchor is looked up by `[data-anchor-path][data-anchor-line]`
  // (the same hooks DiffView / FilesView / report markdown use). Placed to the
  // right of the line; falls back to below it when the right side is too
  // narrow. Repositioned on scroll and resize (without hiding — the human is
  // typing into it).
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { tick } from "svelte";
  import { state as appState, anchorLabel } from "../state.svelte.js";
  import { onAnchoredFeedback, clearAnchor, copyAnchorPermalink } from "../handlers.js";

  let anchorRect = $state(null);
  let textareaEl = $state();
  let composing = $state(false);
  let prevAnchorKey = null;
  let pendingFocus = false;

  const anchorKey = $derived(
    appState.anchor
      ? `${appState.anchor.path}:${appState.anchor.lineStart}-${appState.anchor.lineEnd}`
      : null,
  );

  // For a multi-line anchor, prefer the row whose data-anchor-line matches
  // lineStart (diff/file rows are per-line). Report markdown blocks span a
  // range; fall back to the first block that overlaps the anchor.
  function findAnchorElement(path, lineStart, lineEnd) {
    const rows = document.querySelectorAll(
      `[data-anchor-path="${CSS.escape(path)}"][data-anchor-line]`,
    );
    let overlap = null;
    for (const el of rows) {
      const start = Number(el.getAttribute("data-anchor-line"));
      const endAttr = el.getAttribute("data-anchor-line-end");
      const end = endAttr !== null ? Number(endAttr) : start;
      if (start > lineEnd || end < lineStart) continue;
      if (start === lineStart) return el;
      if (overlap === null) overlap = el;
    }
    return overlap;
  }

  function recomputeRect() {
    const a = appState.anchor;
    if (!a) { anchorRect = null; return; }
    const el = findAnchorElement(a.path, a.lineStart, a.lineEnd);
    if (!el) { anchorRect = null; return; }
    const r = el.getBoundingClientRect();
    anchorRect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    if (pendingFocus && textareaEl) {
      pendingFocus = false;
      // Focus once the rect is set so the textarea is no longer display:none.
      // tick() lets Svelte apply the derived style before we move focus.
      tick().then(() => textareaEl?.focus());
    }
  }

  // The anchored element is part of the detail body that just rendered; wait
  // for the next tick so the DOM is up to date before measuring.
  $effect(() => {
    void appState.anchor;
    void appState.activeTab;
    void appState.detail;
    void appState.selectedFilePath;
    void appState.collapsedFiles.size;
    void appState.diffExpansions.size;
    tick().then(recomputeRect);
  });

  // Track the line on scroll (any scroll container — the detail body has its
  // own) and on resize, so the box stays glued to it while the human types.
  $effect(() => {
    if (!appState.anchor) return;
    const onScroll = () => recomputeRect();
    const onResize = () => recomputeRect();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  });

  // Auto-focus only on the null → anchored transition, and only when the human
  // isn't already typing into another input (e.g. the bottom-fixed composer).
  // Anchor edits (clicking a different line, Shift+clicking to extend) should
  // reposition without stealing focus mid-typing. The actual focus() call
  // lives in recomputeRect so it runs after anchorRect is non-null (the
  // textarea is display:none until then; focusing a hidden element is a no-op).
  function isTypingElsewhere() {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    const tag = el.tagName;
    return tag === "TEXTAREA" || tag === "INPUT" || el.isContentEditable;
  }
  $effect(() => {
    const key = anchorKey;
    if (key && prevAnchorKey === null && !isTypingElsewhere()) pendingFocus = true;
    prevAnchorKey = key;
  });

  function onKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      clearAnchor();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    if (composing || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    onAnchoredFeedback();
  }

  const POPOVER_WIDTH = 360;
  const POPOVER_HEIGHT_ESTIMATE = 140;
  const GAP = 8;
  const style = $derived.by(() => {
    const r = anchorRect;
    if (!r) return "display:none";
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const spaceRight = vw - r.right;
    let left;
    let top;
    if (spaceRight >= POPOVER_WIDTH + GAP * 2) {
      left = r.right + GAP;
      top = Math.max(GAP, Math.min(r.top, vh - POPOVER_HEIGHT_ESTIMATE - GAP));
    } else {
      left = Math.max(GAP, Math.min(r.left, vw - POPOVER_WIDTH - GAP));
      const roomBelow = vh - r.bottom;
      top = roomBelow >= POPOVER_HEIGHT_ESTIMATE + GAP || r.top < POPOVER_HEIGHT_ESTIMATE + GAP
        ? r.bottom + GAP
        : Math.max(GAP, r.top - POPOVER_HEIGHT_ESTIMATE - GAP);
    }
    return `left:${Math.round(left)}px; top:${Math.round(top)}px; width:${POPOVER_WIDTH}px`;
  });
</script>

{#if appState.anchor}
  <form
    class="anchored-composer"
    style={style}
    onsubmit={(e) => { e.preventDefault(); onAnchoredFeedback(); }}
  >
    <div class="anchor-chip">
      Re: {anchorLabel(appState.anchor)}
      <button type="button" title="GitHub permalink をコピー" onclick={copyAnchorPermalink}>🔗</button>
      <button type="button" title="clear anchor" onclick={clearAnchor}>×</button>
    </div>
    <textarea
      id="anchoredFeedbackInput"
      bind:this={textareaEl}
      rows="3"
      placeholder="Comment on the selected lines... (Enter で送信 / Shift+Enter で改行 / Esc で解除)"
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => (composing = false)}
      onkeydown={onKeydown}
    ></textarea>
    <div class="row">
      <span class="spacer"></span>
      <button type="submit">Send feedback</button>
    </div>
  </form>
{/if}
