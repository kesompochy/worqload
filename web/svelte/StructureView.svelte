<script>
  // The Structure tab: an import-dependency graph of the changeset's files and
  // their immediate neighborhood (the files they import / that import them),
  // with import cycles flagged. Mounted by DetailBody when the Structure tab is
  // active. The data comes from GET /sessions/:id/structure (held in
  // appState.structure); buildStructureModel places the boxes and connectors,
  // this draws the SVG. Nodes carry `data-structure-open`, so a click is picked
  // up by DetailBody's delegated handler (which opens the file in the Files tab).
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState } from "../state.svelte.js";
  import { buildStructureModel } from "../structure-view.js";

  const data = $derived(appState.structure);
  const model = $derived(data && data.graph ? buildStructureModel(data) : null);

  // A short cubic between two box-edge anchor points. Forward edges (left→right,
  // following the import) curve gently; a back/same-layer edge bows up and out
  // so it reads as "closes a loop" rather than running straight through columns.
  function edgePath(edge) {
    const reach = Math.max(40, Math.abs(edge.x2 - edge.x1) * 0.5);
    if (edge.forward) {
      return `M${edge.x1},${edge.y1} C${edge.x1 + reach},${edge.y1} ${edge.x2 - reach},${edge.y2} ${edge.x2},${edge.y2}`;
    }
    const lift = 30 + Math.abs(edge.y2 - edge.y1) * 0.2;
    const apex = Math.min(edge.y1, edge.y2) - lift;
    return `M${edge.x1},${edge.y1} C${edge.x1 + reach},${apex} ${edge.x2 - reach},${apex} ${edge.x2},${edge.y2}`;
  }
</script>

<div class="structure-view">
  {#if !data || data.loading}
    <div class="structure-message">依存グラフを読み込み中…</div>
  {:else if data.error}
    <div class="structure-message structure-error">読み込みに失敗しました: {data.error}</div>
  {:else if !model || !model.hasGraph}
    <div class="structure-message">
      この変更について図示できる import 依存関係がありません。
      （グラフ化の対象は JavaScript / TypeScript / Svelte ファイルのみ。変更ファイルが孤立しているか、import グラフ未対応の言語です。）
    </div>
  {:else}
    {#if model.cycles.length > 0}
      <div class="structure-cycles">
        ⚠ import 循環 {model.cycles.length} 件:
        {#each model.cycles as cycle, i}{#if i > 0} · {/if}<span class="structure-cycle-label">{cycle.label}</span>{/each}
      </div>
    {/if}
    <div class="structure-canvas">
      <svg width={model.width} height={model.height} viewBox="0 0 {model.width} {model.height}" role="img" aria-label="import dependency graph">
        <defs>
          <marker id="structure-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" />
          </marker>
          <marker id="structure-arrow-cycle" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" class="cycle" />
          </marker>
        </defs>
        {#each model.edges as edge}
          <path
            class="structure-edge"
            class:cycle={edge.inCycle}
            d={edgePath(edge)}
            marker-end={edge.inCycle ? "url(#structure-arrow-cycle)" : "url(#structure-arrow)"}
          />
        {/each}
        {#each model.nodes as node (node.path)}
          <g
            class="structure-node"
            class:changed={node.changed}
            class:cycle={node.inCycle}
            data-structure-open={node.path}
            transform="translate({node.x},{node.y})"
          >
            <title>{node.path}</title>
            <rect width={node.width} height={node.height} rx="5" />
            <text x={node.width / 2} y={node.height / 2}>{node.label}</text>
          </g>
        {/each}
      </svg>
    </div>
  {/if}
</div>
