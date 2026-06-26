<script>
  // The Diff tab's body: a left tree of the changed files and, to its right, a
  // GitHub-style rendering of the branch's full-context unified diff with
  // unchanged stretches collapsed behind expandable placeholders. Mounted by
  // DetailBody.svelte. The diff structural model is built by buildDiffModel
  // (pure, in diff-view.js); the tree rows are flattened by flattenFileTree
  // (pure, in files-view.js) off the same file list. This component only paints
  // them. Every clickable element keeps the data-* hooks that handlers.js's
  // onDetailBodyClick delegates on (file collapse, gap expand, copy-path, line
  // anchoring, diff-tree directory toggle, diff-tree file jump) — there are no
  // local click handlers.
  // (`state` is imported as `appState`: a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState, isAnchored, feedbacksAnchoredAt, DIFF_EXPAND_CHUNK } from "../state.svelte.js";
  import { buildDiffModel } from "../diff-view.js";
  import { flattenFileTree } from "../files-view.js";
  import { highlightCode } from "../syntax-highlight.js";

  const model = $derived(buildDiffModel(appState.diff, appState.collapsedFiles, appState.diffExpansions));
  const treeRows = $derived(flattenFileTree(model.files.map(f => f.path), appState.diffTreeCollapsed));
  const indent = depth => `padding-left:${(0.3 + depth * 0.9).toFixed(2)}rem`;
</script>

{#if model.empty}
  <div class="diff-empty">No changes on this branch yet.</div>
{:else}
  <div class="diff-explorer">
    <div class="file-tree-pane">
      <div class="file-tree-list">
        {#each treeRows as row (row.path)}
          {#if row.kind === "dir"}
            <div class="file-tree-row is-dir" class:collapsed={row.collapsed} data-diff-dir-toggle={row.path} style={indent(row.depth)} title={row.path}>
              <span class="twisty">▾</span><span class="name">{row.name}/</span>
            </div>
          {:else}
            <div class="file-tree-row is-file" data-diff-file-jump={row.path} style={indent(row.depth)} title={row.path}>
              <span class="twisty">▾</span><span class="name">{row.name}</span>
            </div>
          {/if}
        {/each}
      </div>
    </div>
    <div class="diff-files-pane">
      {#each model.files as file (file.path)}
        <div class="diff-file" class:collapsed={file.collapsed} data-diff-path={file.path}>
          <div class="diff-file-header" data-diff-toggle={file.path}>
            <span class="diff-chevron">▾</span>
            <span>{file.path}</span>
            <button type="button" class="copy-path-btn" data-copy-path={file.path} title="ファイル名をコピー">⧉</button>
            <button type="button" class="copy-path-btn" data-permalink-path={file.path} title="GitHub permalink をコピー">🔗</button>
            <button type="button" class="copy-path-btn" data-structure-anchor={file.path} title="このファイルを起点に Structure を描画">⌘</button>
            <span class="diff-summary"><span class="add-count">+{file.adds}</span><span class="remove-count">−{file.removes}</span></span>
          </div>
          <div class="diff-file-body">
            {#each file.hunks as hunk}
              <div class="diff-hunk">{hunk.header}</div>
              {#each hunk.segments as seg}
                {#if seg.type === "gap"}
                  {#if seg.chunked}
                  <div class="diff-line diff-expand-row">
                    <span class="ln">⋯</span>
                    <span class="ln"></span>
                    <span class="body"><button type="button" class="diff-expand-btn" data-expand-path={file.path} data-expand-from={seg.from} data-expand-to={seg.to} data-expand-dir="down" title="Expand {DIFF_EXPAND_CHUNK} lines from above">↓</button><span class="diff-expand-label">{seg.count} unchanged line{seg.count === 1 ? "" : "s"}</span><button type="button" class="diff-expand-btn" data-expand-path={file.path} data-expand-from={seg.from} data-expand-to={seg.to} data-expand-dir="up" title="Expand {DIFF_EXPAND_CHUNK} lines from below">↑</button><button type="button" class="diff-expand-btn" data-expand-path={file.path} data-expand-from={seg.from} data-expand-to={seg.to} data-expand-dir="all" title="Expand all">⤓</button></span>
                  </div>
                  {:else}
                  <div class="diff-line diff-expand-row" data-expand-path={file.path} data-expand-from={seg.from} data-expand-to={seg.to} data-expand-dir="all" role="button">
                    <span class="ln">⋯</span>
                    <span class="ln"></span>
                    <span class="body"><span class="diff-expand-label">{seg.count} unchanged line{seg.count === 1 ? "" : "s"}</span></span>
                  </div>
                  {/if}
                {:else if seg.row.kind === "meta"}
                  <div class="diff-line meta"><span class="ln"></span><span class="ln"></span><span class="body">{seg.row.body}</span></div>
                {:else}
                  {@const fbHere = seg.row.anchorable ? feedbacksAnchoredAt(file.path, seg.row.newNo) : []}
                  <div class="diff-line {seg.row.kind}" class:selected={seg.row.anchorable && isAnchored(file.path, seg.row.newNo)} class:has-feedback={fbHere.length > 0} data-feedback-preview={fbHere.length > 0 ? fbHere.join(",") : undefined} data-anchor-line={seg.row.anchorable ? seg.row.newNo : undefined} data-anchor-path={seg.row.anchorable ? file.path : undefined}>
                    <span class="ln">{seg.row.kind === "remove" ? seg.row.oldNo : ""}</span>
                    <span class="ln">{seg.row.kind === "remove" ? "" : seg.row.newNo}</span>
                    <span class="body">{@html highlightCode(seg.row.body, file.lang, seg.row.anchorable ? { wrapIdentifiers: true } : undefined)}</span>
                  </div>
                {/if}
              {/each}
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}
