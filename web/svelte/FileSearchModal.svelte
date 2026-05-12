<script>
  // Files tab full-text search (Ctrl/Cmd+F). Opened via the exported open()
  // (wired to the keydown handler in main.ts). The human types a query; matches
  // are fetched from GET /sessions/:id/search as they type (debounced); picking
  // one switches to the Files tab and opens that file. Arrow keys move the
  // highlighted hit, Enter opens it, Escape closes.
  import { searchFiles, selectFile } from "../api.js";
  import { switchTab } from "../handlers.js";

  const MIN_QUERY_LENGTH = 2;
  const SEARCH_DEBOUNCE_MS = 200;

  let visible = $state(false);
  let query = $state("");
  let matches = $state([]);
  let truncated = $state(false);
  let searching = $state(false);
  let selectedIndex = $state(0);
  // The query the currently-shown `matches` are for — so "no hits" only shows
  // once a search has actually run for what's typed, not while it's in flight.
  let resultQuery = $state("");

  let debounceTimer = null;
  // Bumped on every search kicked off; a resolved fetch only applies if it's
  // still the latest, so out-of-order responses don't clobber newer results.
  let searchToken = 0;

  export function open() {
    query = "";
    matches = [];
    truncated = false;
    searching = false;
    selectedIndex = 0;
    resultQuery = "";
    visible = true;
  }

  function close() {
    visible = false;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  }

  function autofocus(node) {
    node.focus();
  }

  // Debounce the per-keystroke search; below the minimum length just clear.
  $effect(() => {
    if (!visible) return;
    const q = query.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (q.length < MIN_QUERY_LENGTH) {
      searchToken++;
      matches = [];
      truncated = false;
      searching = false;
      resultQuery = "";
      return;
    }
    searching = true;
    const token = ++searchToken;
    debounceTimer = setTimeout(async () => {
      const res = await searchFiles(q);
      if (token !== searchToken) return;
      matches = res.matches ?? [];
      truncated = !!res.truncated;
      selectedIndex = 0;
      searching = false;
      resultQuery = q;
    }, SEARCH_DEBOUNCE_MS);
  });

  async function openMatch(match) {
    if (!match) return;
    close();
    await switchTab("files");
    selectFile(match.path);
  }

  function onKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, matches.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      openMatch(matches[selectedIndex]);
    }
  }
</script>

{#if visible}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-bg" onclick={close}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal file-search-modal" onclick={(e) => e.stopPropagation()}>
      <h2>ファイル内検索</h2>
      <input
        bind:value={query}
        use:autofocus
        onkeydown={onKeydown}
        placeholder="ワークツリー内のファイルを全文検索…"
      />
      <div class="file-search-results">
        {#if query.trim().length < MIN_QUERY_LENGTH}
          <div class="file-search-hint">{MIN_QUERY_LENGTH}文字以上で検索します。</div>
        {:else if searching && matches.length === 0}
          <div class="file-search-hint"><span class="spinner"></span> 検索中…</div>
        {:else if matches.length === 0 && resultQuery === query.trim()}
          <div class="file-search-hint">一致するものはありません。</div>
        {:else}
          {#if truncated}<div class="file-search-hint">最初の{matches.length}件を表示（さらに一致あり — 絞り込んでください）。</div>{/if}
          <ul class="file-search-list">
            {#each matches as match, i (match.path + ":" + match.line)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <li class="file-search-row" class:selected={i === selectedIndex} onclick={() => openMatch(match)} onmouseenter={() => selectedIndex = i}>
                <span class="file-search-loc">{match.path}<span class="file-search-lineno">:{match.line}</span></span>
                <span class="file-search-text">{match.text}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </div>
{/if}
