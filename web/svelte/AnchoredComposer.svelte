<script>
  // A small floating feedback composer that surfaces next to an anchored line
  // or block while `state.anchor` is set. The bottom-fixed composer
  // (Composer.svelte) stays as-is; this one removes the cursor-travel back to
  // the bottom of the pane after anchoring. Mounted on document.body (from
  // main.ts) so it floats over the detail pane.
  //
  // Position: anchor is looked up by `[data-anchor-path][data-anchor-line]`
  // (the same hooks DiffView / FilesView / report markdown use). For a single
  // line we place to the right (falling back to below when the right side is
  // too narrow). For a multi-line range we always place below the entire
  // range — placing next to the top would leave the popover overlapping the
  // bottom-fixed composer when the range reaches near the bottom of the pane.
  // Repositioned on scroll and resize (without hiding — the human is typing
  // into it).
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

  // The bounding box of every row/block that overlaps [lineStart, lineEnd] for
  // `path`. DiffView/FilesView render each line as its own row; report markdown
  // blocks span a line range. For multi-line anchors we need the full extent
  // (top of the first row down to the bottom of the last) so the popover can
  // sit below the entire range.
  function findAnchorRect(path, lineStart, lineEnd) {
    const rows = document.querySelectorAll(
      `[data-anchor-path="${CSS.escape(path)}"][data-anchor-line]`,
    );
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    let found = false;
    for (const el of rows) {
      const start = Number(el.getAttribute("data-anchor-line"));
      const endAttr = el.getAttribute("data-anchor-line-end");
      const end = endAttr !== null ? Number(endAttr) : start;
      if (start > lineEnd || end < lineStart) continue;
      const r = el.getBoundingClientRect();
      if (r.top < top) top = r.top;
      if (r.bottom > bottom) bottom = r.bottom;
      if (r.left < left) left = r.left;
      if (r.right > right) right = r.right;
      found = true;
    }
    return found ? { top, bottom, left, right } : null;
  }

  function recomputeRect() {
    const a = appState.anchor;
    if (!a) { anchorRect = null; return; }
    const r = findAnchorRect(a.path, a.lineStart, a.lineEnd);
    if (!r) { anchorRect = null; return; }
    anchorRect = r;
    if (pendingFocus && textareaEl) {
      pendingFocus = false;
      // Focus once the rect is set so the textarea is no longer display:none.
      // tick() lets Svelte apply the derived style before we move focus.
      tick().then(() => textareaEl?.focus());
    }
  }

  // The effective viewport bottom for placement — the top of the bottom-fixed
  // composer when present, so the floating popover doesn't tuck under it.
  function effectiveViewportBottom() {
    const el = document.querySelector(".feedback-form");
    return el ? el.getBoundingClientRect().top : window.innerHeight;
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

  const POPOVER_WIDTH = 440;
  const POPOVER_HEIGHT_ESTIMATE = 130;
  const GAP = 8;
  const style = $derived.by(() => {
    const r = anchorRect;
    if (!r) return "display:none";
    const a = appState.anchor;
    const isMultiLine = !!a && a.lineEnd > a.lineStart;
    const vw = window.innerWidth;
    const viewportBottom = effectiveViewportBottom();
    let left;
    let top;
    if (isMultiLine) {
      // Below the entire range, so the popover never sits alongside more rows
      // than it has height for. If there isn't room below the range before the
      // bottom composer, fall back to above the range.
      left = Math.max(GAP, Math.min(r.left, vw - POPOVER_WIDTH - GAP));
      const roomBelow = viewportBottom - r.bottom;
      top = roomBelow >= POPOVER_HEIGHT_ESTIMATE + GAP
        ? r.bottom + GAP
        : Math.max(GAP, r.top - POPOVER_HEIGHT_ESTIMATE - GAP);
    } else {
      // Single line: prefer the right side; below as the fallback.
      const spaceRight = vw - r.right;
      if (spaceRight >= POPOVER_WIDTH + GAP * 2) {
        left = r.right + GAP;
        top = Math.max(GAP, Math.min(r.top, viewportBottom - POPOVER_HEIGHT_ESTIMATE - GAP));
      } else {
        left = Math.max(GAP, Math.min(r.left, vw - POPOVER_WIDTH - GAP));
        const roomBelow = viewportBottom - r.bottom;
        top = roomBelow >= POPOVER_HEIGHT_ESTIMATE + GAP || r.top < POPOVER_HEIGHT_ESTIMATE + GAP
          ? r.bottom + GAP
          : Math.max(GAP, r.top - POPOVER_HEIGHT_ESTIMATE - GAP);
      }
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
