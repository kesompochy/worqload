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
    {@render section("定義", nav.definitions, nav.definitionsStatus)}
    {@render section("使用箇所", nav.references, nav.referencesStatus)}
  </div>

  {#snippet section(title, locations, status)}
    <div class="code-nav-section">
      <div class="code-nav-section-title">{title}{#if status === "done"} ({locations.length}){/if}</div>
      {#if status === "loading"}
        <div class="code-nav-empty"><span class="spinner"></span> 解決中…</div>
      {:else if locations.length === 0}
        <div class="code-nav-empty">見つかりません</div>
      {:else}
        <div class="code-nav-refs">
          {#each locations as loc, i (loc.path + ":" + loc.line + ":" + i)}
            <button type="button" class="code-nav-item" onclick={() => revealFileLocation(loc.path, loc.line)}>
              <span class="code-nav-loc">{loc.path}<span class="code-nav-lineno">:{loc.line}</span></span>
              {#if loc.text}<span class="code-nav-text">{loc.text}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/snippet}
{/if}
