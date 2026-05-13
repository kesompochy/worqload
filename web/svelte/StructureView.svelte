<script>
  // The Structure tab: an import-dependency graph of the changeset's files and
  // their immediate neighborhood (the files they import / that import them).
  // Import cycles show up as dashed red edges (and red node borders); the names
  // each import carries are written onto the edges (toggleable). Hovering or
  // focusing a node highlights it, its direct neighbours, and the connecting
  // edges, and dims the rest. Mounted by DetailBody when the Structure tab is
  // active. The data comes from GET /sessions/:id/structure (held in
  // appState.structure); buildStructureModel places the boxes and connectors,
  // this draws the SVG. Nodes carry `data-structure-open`, so a click is picked
  // up by DetailBody's delegated handler (which opens the file in the Files tab);
  // keyboard activation (Enter/Space on a focused node) is handled here.
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState } from "../state.svelte.js";
  import { buildStructureModel } from "../structure-view.js";
  import { openFileFromStructure } from "../handlers.js";

  const data = $derived(appState.structure);
  const model = $derived(data && data.graph ? buildStructureModel(data) : null);

  const edgeKey = edge => `${edge.from} ${edge.to}`;

  // The full symbol list for an edge's tooltip / the details list.
  function symbolsLabel(symbols) {
    if (!symbols || symbols.length === 0) return "(副作用 import のみ)";
    return `{ ${symbols.join(", ")} }`;
  }
  function edgeTitle(edge) {
    return `${edge.from} → ${edge.to}\n${symbolsLabel(edge.symbols)}`;
  }
  // Edges sorted for the "依存の詳細" list: by importing file, then imported file.
  const edgeDetails = $derived(
    model && model.hasGraph
      ? [...model.edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
      : [],
  );

  // The node currently hovered/focused, and the set of paths and edge-keys
  // related to it (itself, its direct neighbours, the edges between). `null`
  // when nothing is hovered — then nothing is dimmed.
  let hoveredPath = $state(null);
  const related = $derived.by(() => {
    if (!hoveredPath || !model || !model.hasGraph) return null;
    const paths = new Set([hoveredPath]);
    const keys = new Set();
    for (const edge of model.edges) {
      if (edge.from === hoveredPath || edge.to === hoveredPath) {
        paths.add(edge.from);
        paths.add(edge.to);
        keys.add(edgeKey(edge));
      }
    }
    return { paths, keys };
  });
  const nodeDimmed = path => related != null && !related.paths.has(path);
  const edgeDimmed = edge => related != null && !related.keys.has(edgeKey(edge));

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

  function onNodeKeydown(event, path) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openFileFromStructure(path);
    }
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
    <div class="structure-toolbar">
      <label><input type="checkbox" bind:checked={appState.structureShowSymbols} /> シンボル名を表示</label>
    </div>
    <div class="structure-canvas" class:structure-focusing={related != null}>
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
            class:dim={edgeDimmed(edge)}
            d={edgePath(edge)}
            marker-end={edge.inCycle ? "url(#structure-arrow-cycle)" : "url(#structure-arrow)"}
          ><title>{edgeTitle(edge)}</title></path>
        {/each}
        {#if appState.structureShowSymbols}
          {#each model.edges as edge}
            {#if edge.label}
              <g class="structure-edge-label" class:dim={edgeDimmed(edge)} transform="translate({edge.labelX},{edge.labelY})">
                <title>{edgeTitle(edge)}</title>
                <rect x={-edge.labelWidth / 2} y="-8" width={edge.labelWidth} height="16" rx="3" />
                <text>{edge.label}</text>
              </g>
            {/if}
          {/each}
        {/if}
        {#each model.nodes as node (node.path)}
          <g
            class="structure-node"
            class:changed={node.changed}
            class:cycle={node.inCycle}
            class:dim={nodeDimmed(node.path)}
            data-structure-open={node.path}
            transform="translate({node.x},{node.y})"
            role="button"
            tabindex="0"
            aria-label={`${node.path} — open in Files`}
            onmouseenter={() => (hoveredPath = node.path)}
            onmouseleave={() => (hoveredPath = null)}
            onfocus={() => (hoveredPath = node.path)}
            onblur={() => (hoveredPath = null)}
            onkeydown={e => onNodeKeydown(e, node.path)}
          >
            <title>{node.path}</title>
            <rect width={node.width} height={node.height} rx="5" />
            <text x={node.width / 2} y={node.height / 2}>{node.label}</text>
          </g>
        {/each}
      </svg>
    </div>
    <details class="structure-details">
      <summary>依存の詳細 ({edgeDetails.length})</summary>
      <ul>
        {#each edgeDetails as edge}
          <li>
            <button type="button" class="structure-detail-file" class:changed={model.nodes.find(n => n.path === edge.from)?.changed} data-structure-open={edge.from}>{edge.from}</button>
            <span class="structure-detail-arrow">→</span>
            <button type="button" class="structure-detail-file" class:changed={model.nodes.find(n => n.path === edge.to)?.changed} data-structure-open={edge.to}>{edge.to}</button>
            <span class="structure-detail-symbols">{symbolsLabel(edge.symbols)}</span>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</div>
