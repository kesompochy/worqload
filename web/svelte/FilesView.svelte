<script>
  // The Files tab's body: a worktree file explorer (tree on the left, the
  // selected file's text on the right, with an inline editor and file
  // create/delete/rename). Mounted by DetailBody.svelte. The tree rows come
  // from flattenFileTree (pure, in files-view.js) off the reactive view state;
  // this component only paints them and the file content. Every clickable
  // element keeps the data-* hooks that handlers.js's onDetailBodyClick
  // delegates on (directory collapse, file open, copy-path, line anchoring,
  // edit/save, new-file, delete, rename) — there are no local click handlers.
  // The text inputs (editor textarea, new-file path, rename path) two-way bind
  // to view state; the new-file and rename inputs also have local keydown
  // handlers so Enter confirms, with the same IME-composition guard
  // SessionList.svelte's rename input uses. `focusOnShow` moves focus to an
  // input as it appears.
  // (`state` is imported as `appState`: a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState, isAnchored, feedbacksAnchoredAt } from "../state.svelte.js";
  import { flattenFileTree } from "../files-view.js";
  import { highlightCode, languageForPath } from "../syntax-highlight.js";
  import { formatBytes } from "../dom.js";
  import { createFile, renameFile } from "../api.js";

  function focusOnShow(node) { node.focus(); }

  // True while an IME composition is in progress in the new-file / rename
  // input, so a confirming Enter that merely closes the composition doesn't
  // also commit. `event.isComposing` / `keyCode === 229` cover browsers that
  // report it on the keydown itself; the tracked flag covers the rest.
  let creatingComposing = $state(false);
  let renamingComposing = $state(false);

  function onNewFileKeydown(event) {
    if (creatingComposing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      appState.fileCreating = false;
    } else if (event.key === "Enter") {
      event.preventDefault();
      void createFile(appState.fileNewPath);
    }
  }

  function onRenameKeydown(event) {
    if (renamingComposing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      appState.fileRenaming = false;
    } else if (event.key === "Enter") {
      event.preventDefault();
      void renameFile(appState.fileRenamePath);
    }
  }

  const treeRows = $derived(flattenFileTree(appState.files, appState.fileTreeCollapsed));
  const indent = depth => `padding-left:${(0.3 + depth * 0.9).toFixed(2)}rem`;

  const fileContentPath = $derived(appState.fileContent?.path || appState.selectedFilePath || "");
  const fileLines = $derived.by(() => {
    const fc = appState.fileContent;
    if (!fc || fc.loading || fc.error || fc.binary || fc.tooLarge || fc.image) return null;
    const lang = languageForPath(fileContentPath);
    const lines = (fc.content ?? "").split("\n");
    // A trailing newline yields a final empty element; drop it so there's no phantom last line.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines.map((line, i) => ({ no: i + 1, html: highlightCode(line, lang, { wrapIdentifiers: true }) }));
  });
  const fileContentMeta = $derived.by(() => {
    const fc = appState.fileContent;
    if (!fc || fc.loading || fc.error) return "";
    if (fc.image) return "image";
    if (fc.binary) return "binary";
    if (fc.tooLarge) return formatBytes(fc.size);
    if (fileLines) return `${fileLines.length} line${fileLines.length === 1 ? "" : "s"}`;
    return "";
  });
  // The editor only opens for files the read-only view can fully show as text
  // (not loading / error / binary / too-large).
  const editable = $derived(fileLines !== null);
  // Rename / delete apply to any readable file (binary and too-large included),
  // so they gate on the file being loaded rather than on `editable`.
  const fileActionable = $derived(
    !!appState.fileContent && !appState.fileContent.loading && !appState.fileContent.error && !appState.fileEditing,
  );
</script>

<div class="file-explorer">
  <div class="file-tree-pane">
    <div class="file-tree-header">
      {#if appState.fileCreating}
        <input
          class="file-new-input"
          type="text"
          placeholder="新しいファイルのパス（Enter で作成）"
          bind:value={appState.fileNewPath}
          use:focusOnShow
          oncompositionstart={() => (creatingComposing = true)}
          oncompositionend={() => (creatingComposing = false)}
          onkeydown={onNewFileKeydown}
        />
        <div class="file-new-actions">
          <button type="button" class="file-edit-btn is-save" data-file-new-confirm>作成</button>
          <button type="button" class="file-edit-btn" data-file-new-cancel>キャンセル</button>
        </div>
      {:else}
        <button type="button" class="file-new-btn" data-file-new>＋ 新規ファイル</button>
      {/if}
    </div>
    {#if !appState.filesLoaded}
      <div class="empty"><span class="spinner"></span> loading…</div>
    {:else if appState.files.length === 0}
      <div class="empty">No files in this worktree.</div>
    {:else}
      <div class="file-tree-list">
        {#each treeRows as row (row.path)}
          {#if row.kind === "dir"}
            <div class="file-tree-row is-dir" class:collapsed={row.collapsed} data-dir-toggle={row.path} style={indent(row.depth)} title={row.path}>
              <span class="twisty">▾</span><span class="name">{row.name}/</span>
            </div>
          {:else}
            <div class="file-tree-row is-file" class:selected={row.path === appState.selectedFilePath} data-file-open={row.path} style={indent(row.depth)} title={row.path}>
              <span class="twisty">▾</span><span class="name">{row.name}</span>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
  <div class="file-content-pane">
    {#if !appState.fileContent}
      <div class="placeholder">Select a file from the tree to view it.</div>
    {:else}
      <div class="file-content-header">
        {#if appState.fileRenaming}
          <input
            class="file-rename-input"
            type="text"
            placeholder="新しいパス（Enter で変更）"
            bind:value={appState.fileRenamePath}
            use:focusOnShow
            oncompositionstart={() => (renamingComposing = true)}
            oncompositionend={() => (renamingComposing = false)}
            onkeydown={onRenameKeydown}
          />
          <button type="button" class="file-edit-btn is-save" data-file-rename-confirm>確定</button>
          <button type="button" class="file-edit-btn" data-file-rename-cancel>キャンセル</button>
        {:else}
          <span>{fileContentPath}</span>
          <button type="button" class="copy-path-btn" data-copy-path={fileContentPath} title="ファイル名をコピー">⧉</button>
          <button type="button" class="copy-path-btn" data-permalink-path={fileContentPath} title="GitHub permalink をコピー">🔗</button>
          <button type="button" class="copy-path-btn" data-structure-anchor={fileContentPath} title="このファイルを起点に Structure を描画">⌘</button>
          {#if editable && !appState.fileEditing}
            <button type="button" class="copy-path-btn" data-file-edit title="このファイルを編集">✎</button>
          {/if}
          {#if fileActionable}
            <button type="button" class="copy-path-btn" data-file-rename title="ファイル名を変更">🏷</button>
            <button type="button" class="copy-path-btn" data-file-delete title="このファイルを削除">🗑</button>
          {/if}
          {#if appState.fileEditing}
            <button type="button" class="file-edit-btn is-save" data-file-edit-save>保存</button>
            <button type="button" class="file-edit-btn" data-file-edit-cancel>キャンセル</button>
          {/if}
          {#if fileContentMeta}<span class="file-content-meta">{fileContentMeta}</span>{/if}
        {/if}
      </div>
      {#if appState.fileContent.loading}
        <div class="file-msg"><span class="spinner"></span> loading…</div>
      {:else if appState.fileContent.error}
        <div class="file-msg">⚠ {appState.fileContent.error}</div>
      {:else if appState.fileContent.binary}
        <div class="file-msg">Binary file — not shown.</div>
      {:else if appState.fileContent.tooLarge}
        <div class="file-msg">File too large to display ({formatBytes(appState.fileContent.size)}).</div>
      {:else if appState.fileContent.image}
        <div class="file-image-pane">
          <img class="file-image" src="/sessions/{appState.selected}/file/raw?path={encodeURIComponent(fileContentPath)}" alt={fileContentPath} />
        </div>
      {:else if appState.fileEditing}
        <textarea class="file-editor" spellcheck="false" bind:value={appState.fileEditDraft}></textarea>
      {:else}
        <div class="file-content-body">
          {#each fileLines as line (line.no)}
            {@const fbHere = feedbacksAnchoredAt(fileContentPath, line.no)}
            <div class="file-line" class:selected={isAnchored(fileContentPath, line.no)} class:has-feedback={fbHere.length > 0} data-feedback-preview={fbHere.length > 0 ? fbHere.join(",") : undefined} data-anchor-line={line.no} data-anchor-path={fileContentPath}>
              <span class="ln">{line.no}</span><span class="body">{@html line.html}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>
