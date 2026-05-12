<script>
  // The Files tab's body: a worktree file explorer (tree on the left, the
  // selected file's text on the right). Mounted by DetailBody.svelte. The tree
  // rows come from flattenFileTree (pure, in files-view.js) off the reactive
  // view state; this component only paints them and the file content. Every
  // clickable element keeps the data-* hooks that handlers.js's
  // onDetailBodyClick delegates on (directory collapse, file open, copy-path,
  // line anchoring) — there are no local click handlers.
  // (`state` is imported as `appState`: a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState, isAnchored } from "../state.svelte.js";
  import { flattenFileTree } from "../files-view.js";
  import { highlightCode, languageForPath } from "../syntax-highlight.js";
  import { formatBytes } from "../dom.js";

  const treeRows = $derived(flattenFileTree(appState.files, appState.fileTreeCollapsed));
  const indent = depth => `padding-left:${(0.3 + depth * 0.9).toFixed(2)}rem`;

  const fileContentPath = $derived(appState.fileContent?.path || appState.selectedFilePath || "");
  const fileLines = $derived.by(() => {
    const fc = appState.fileContent;
    if (!fc || fc.loading || fc.error || fc.binary || fc.tooLarge) return null;
    const lang = languageForPath(fileContentPath);
    const lines = (fc.content ?? "").split("\n");
    // A trailing newline yields a final empty element; drop it so there's no phantom last line.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines.map((line, i) => ({ no: i + 1, html: highlightCode(line, lang) }));
  });
  const fileContentMeta = $derived.by(() => {
    const fc = appState.fileContent;
    if (!fc || fc.loading || fc.error) return "";
    if (fc.binary) return "binary";
    if (fc.tooLarge) return formatBytes(fc.size);
    if (fileLines) return `${fileLines.length} line${fileLines.length === 1 ? "" : "s"}`;
    return "";
  });
</script>

<div class="file-explorer">
  <div class="file-tree-pane">
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
        <span>{fileContentPath}</span>
        <button type="button" class="copy-path-btn" data-copy-path={fileContentPath} title="ファイル名をコピー">⧉</button>
        {#if fileContentMeta}<span class="file-content-meta">{fileContentMeta}</span>{/if}
      </div>
      {#if appState.fileContent.loading}
        <div class="file-msg"><span class="spinner"></span> loading…</div>
      {:else if appState.fileContent.error}
        <div class="file-msg">⚠ {appState.fileContent.error}</div>
      {:else if appState.fileContent.binary}
        <div class="file-msg">Binary file — not shown.</div>
      {:else if appState.fileContent.tooLarge}
        <div class="file-msg">File too large to display ({formatBytes(appState.fileContent.size)}).</div>
      {:else}
        <div class="file-content-body">
          {#each fileLines as line (line.no)}
            <div class="file-line" class:selected={isAnchored(fileContentPath, line.no)} data-anchor-line={line.no} data-anchor-path={fileContentPath}>
              <span class="ln">{line.no}</span><span class="body">{@html line.html}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>
