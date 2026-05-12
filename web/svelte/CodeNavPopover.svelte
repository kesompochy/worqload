<script>
  // The Files tab's code-navigation popover. Opened by onDetailBodyClick (in
  // handlers.js) when a symbol token is clicked: it sets appState.codeNav with
  // the symbol, its declaration sites in the open file, and — once the
  // worktree-wide search resolves — its uses. Mounted on document.body from
  // main.ts so it can float over the layout, positioned just below the clicked
  // token. Picking an entry calls revealFileLocation; clicking outside, pressing
  // Escape, or scrolling closes it.
  // (`state` is imported as `appState`: a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState } from "../state.svelte.js";
  import { revealFileLocation, closeCodeNav } from "../handlers.js";

  const nav = $derived(appState.codeNav);

  $effect(() => {
    if (!nav) return;
    const onKeydown = (e) => { if (e.key === "Escape") { e.preventDefault(); closeCodeNav(); } };
    const onScroll = () => closeCodeNav();
    window.addEventListener("keydown", onKeydown);
    // Capture phase so scrolling the detail body (which doesn't bubble) closes it.
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("scroll", onScroll, true);
    };
  });

  const POPOVER_WIDTH = 360;
  const popoverStyle = $derived.by(() => {
    const r = nav?.rect;
    if (!r) return "";
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 8));
    const roomBelow = window.innerHeight - r.bottom;
    // Flip above the token when there isn't much room below it and there's more above.
    return roomBelow < 220 && r.top > roomBelow
      ? `left:${left}px; bottom:${Math.round(window.innerHeight - r.top + 4)}px`
      : `left:${left}px; top:${Math.round(r.bottom + 4)}px`;
  });
</script>

{#if nav}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="code-nav-backdrop" onclick={closeCodeNav}></div>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="code-nav-popover" style={popoverStyle} onclick={(e) => e.stopPropagation()}>
    <div class="code-nav-symbol">{nav.symbol}</div>

    <div class="code-nav-section">
      <div class="code-nav-section-title">定義（このファイル内）</div>
      {#if nav.declarations.length === 0}
        <div class="code-nav-empty">見つかりません</div>
      {:else}
        {#each nav.declarations as d (d.line + ":" + d.column)}
          <button type="button" class="code-nav-item" onclick={() => revealFileLocation(nav.path, d.line)}>
            <span class="code-nav-loc">{nav.path}<span class="code-nav-lineno">:{d.line}</span></span>
          </button>
        {/each}
      {/if}
    </div>

    <div class="code-nav-section">
      <div class="code-nav-section-title">
        使用箇所{#if nav.referencesStatus === "done"} ({nav.references.length}){/if}
      </div>
      {#if nav.referencesStatus === "loading"}
        <div class="code-nav-empty"><span class="spinner"></span> 検索中…</div>
      {:else if nav.references.length === 0}
        <div class="code-nav-empty">見つかりません</div>
      {:else}
        <div class="code-nav-refs">
          {#each nav.references as r (r.path + ":" + r.line)}
            <button type="button" class="code-nav-item" onclick={() => revealFileLocation(r.path, r.line)}>
              <span class="code-nav-loc">{r.path}<span class="code-nav-lineno">:{r.line}</span></span>
              <span class="code-nav-text">{r.text}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
