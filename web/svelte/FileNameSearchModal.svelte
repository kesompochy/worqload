<script>
  // Files tab filename search (Ctrl/Cmd+Shift+P). Opened via the exported open()
  // (wired to the keydown handler in main.ts). The human types a query; the
  // worktree's file list (already fetched for the Files tab, ensured here) is
  // filtered with a fuzzy match as they type; picking one switches to the Files
  // tab and opens that file. Arrow keys move the highlighted path, Enter opens
  // it, Escape closes. Mirrors FileSearchModal.svelte (full-text search), but
  // the matching is client-side over appState.files — no server round-trip.
  import { ensureFilesLoaded, selectFile } from "../api.js";
  import { switchTab } from "../handlers.js";
  // Aliased so the `$state` rune below isn't read as a store subscription on it.
  import { state as appState } from "../state.svelte.js";
  import { matchFilePaths } from "../file-name-search.js";

  let visible = $state(false);
  let query = $state("");
  let selectedIndex = $state(0);
  let loading = $state(false);

  export async function open() {
    query = "";
    selectedIndex = 0;
    loading = true;
    visible = true;
    try {
      await ensureFilesLoaded();
    } finally {
      loading = false;
    }
  }

  function close() {
    visible = false;
  }

  function autofocus(node) {
    node.focus();
  }

  let result = $derived(matchFilePaths(appState.files ?? [], query));
  let matches = $derived(result.matches);
  $effect(() => {
    // Keep the highlight in range as the result set shrinks/grows.
    if (selectedIndex > matches.length - 1) selectedIndex = Math.max(0, matches.length - 1);
  });

  async function openPath(path) {
    if (!path) return;
    close();
    await switchTab("files");
    selectFile(path);
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
      openPath(matches[selectedIndex]);
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
      <h2>ファイル名検索</h2>
      <input
        bind:value={query}
        use:autofocus
        onkeydown={onKeydown}
        placeholder="ワークツリー内のファイル名を検索…"
      />
      <div class="file-search-results">
        {#if loading && (appState.files ?? []).length === 0}
          <div class="file-search-hint"><span class="spinner"></span> 読み込み中…</div>
        {:else if query.trim().length === 0}
          <div class="file-search-hint">ファイル名の一部を入力してください。</div>
        {:else if matches.length === 0}
          <div class="file-search-hint">一致するものはありません。</div>
        {:else}
          {#if result.truncated}<div class="file-search-hint">最初の{matches.length}件を表示（さらに一致あり — 絞り込んでください）。</div>{/if}
          <ul class="file-search-list">
            {#each matches as path, i (path)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <li class="file-search-row" class:selected={i === selectedIndex} onclick={() => openPath(path)} onmouseenter={() => selectedIndex = i}>
                <span class="file-search-loc">{path}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </div>
{/if}
