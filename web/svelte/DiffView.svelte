<script>
  // The Diff tab's body: a GitHub-style rendering of the branch's full-context
  // unified diff, with unchanged stretches collapsed behind expandable
  // placeholders. Mounted by DetailBody.svelte. The structural model is built
  // by buildDiffModel (pure, in diff-view.js) off the reactive view state; this
  // component only paints it. Every clickable element keeps the data-* hooks
  // that handlers.js's onDetailBodyClick delegates on (file collapse, gap
  // expand, copy-path, line anchoring) — there are no local click handlers.
  // (`state` is imported as `appState`: a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState, isAnchored, feedbacksAnchoredAt, DIFF_EXPAND_CHUNK } from "../state.svelte.js";
  import { buildDiffModel } from "../diff-view.js";
  import { highlightCode } from "../syntax-highlight.js";

  const model = $derived(buildDiffModel(appState.diff, appState.collapsedFiles, appState.diffExpansions));
</script>

{#if model.empty}
  <div class="diff-empty">No changes on this branch yet.</div>
{:else}
  {#each model.files as file (file.path)}
    <div class="diff-file" class:collapsed={file.collapsed} data-diff-path={file.path}>
      <div class="diff-file-header" data-diff-toggle={file.path}>
        <span class="diff-chevron">▾</span>
        <span>{file.path}</span>
        <button type="button" class="copy-path-btn" data-copy-path={file.path} title="ファイル名をコピー">⧉</button>
        <button type="button" class="copy-path-btn" data-permalink-path={file.path} title="GitHub permalink をコピー">🔗</button>
        <span class="diff-summary"><span class="add-count">+{file.adds}</span><span class="remove-count">−{file.removes}</span></span>
      </div>
      <div class="diff-file-body">
        {#each file.hunks as hunk}
          <div class="diff-hunk">{hunk.header}</div>
          {#each hunk.segments as seg}
            {#if seg.type === "gap"}
              <!-- The whole row falls back to data-expand-dir="all"; the ↑/↓ buttons override it. -->
              <div class="diff-line diff-expand-row" data-expand-path={file.path} data-expand-from={seg.from} data-expand-to={seg.to} data-expand-dir="all" role="button">
                <span class="ln">⋯</span>
                <span class="ln"></span>
                <span class="body">{#if seg.chunked}<button type="button" class="diff-expand-btn" data-expand-path={file.path} data-expand-from={seg.from} data-expand-to={seg.to} data-expand-dir="down" title="Expand {DIFF_EXPAND_CHUNK} lines from above">↓</button>{/if}<span class="diff-expand-label">{seg.count} unchanged line{seg.count === 1 ? "" : "s"}{seg.chunked ? " — click to expand all" : " — click to expand"}</span>{#if seg.chunked}<button type="button" class="diff-expand-btn" data-expand-path={file.path} data-expand-from={seg.from} data-expand-to={seg.to} data-expand-dir="up" title="Expand {DIFF_EXPAND_CHUNK} lines from below">↑</button>{/if}</span>
              </div>
            {:else if seg.row.kind === "meta"}
              <div class="diff-line meta"><span class="ln"></span><span class="ln"></span><span class="body">{seg.row.body}</span></div>
            {:else}
              {@const fbHere = seg.row.anchorable ? feedbacksAnchoredAt(file.path, seg.row.newNo) : []}
              <div class="diff-line {seg.row.kind}" class:selected={seg.row.anchorable && isAnchored(file.path, seg.row.newNo)} class:has-feedback={fbHere.length > 0} data-feedback-preview={fbHere.length > 0 ? fbHere.join(",") : undefined} data-anchor-line={seg.row.anchorable ? seg.row.newNo : undefined} data-anchor-path={seg.row.anchorable ? file.path : undefined}>
                <span class="ln">{seg.row.kind === "remove" ? seg.row.oldNo : ""}</span>
                <span class="ln">{seg.row.kind === "remove" ? "" : seg.row.newNo}</span>
                <span class="body">{@html highlightCode(seg.row.body, file.lang)}</span>
              </div>
            {/if}
          {/each}
        {/each}
      </div>
    </div>
  {/each}
{/if}
