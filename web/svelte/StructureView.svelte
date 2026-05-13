<script>
  // The Structure tab: an import-dependency graph of the changeset's files and
  // their neighbourhood. Click a node to open it in the Files tab; shift+click
  // to *focus* — the canvas redraws filtered to that node, its direct
  // neighbours, and the edges between, with the focused node's full path
  // shown. The toolbar's "Clear focus" returns to the whole graph.
  //
  // Hovering a node still dims the unrelated nodes/edges as a preview; hovering
  // a truncated edge label expands that label in place. The manual zoom
  // (−/Fit/+/%) is independent of all that.
  //
  // Mounted by DetailBody when the Structure tab is active. The data comes from
  // GET /sessions/:id/structure (held in appState.structure); buildStructureModel
  // places the boxes and connectors, this draws the SVG. Nodes carry
  // `data-structure-open`, so click/shift-click handling is in
  // onDetailBodyClick's delegated handler (web/handlers.js); keyboard
  // activation (Enter / shift+Enter on a focused node) is handled here.
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState } from "../state.svelte.js";
  import { buildStructureModel } from "../structure-view.js";
  import { openFileFromStructure, setStructureFocus } from "../handlers.js";
  import { ensureCallGraphLoaded } from "../api.js";

  // "file" mode draws the import graph (state.structure); "function" mode
  // draws the call graph (state.callGraph). The toolbar toggle switches modes
  // and triggers the call-graph fetch on demand.
  const mode = $derived(appState.structureMode);
  const data = $derived(mode === "function" ? appState.callGraph : appState.structure);
  // Function-mode nodes carry presentation data in `nodeMeta`; the basename
  // fallback is the import-graph behaviour.
  const nodeMeta = $derived(data && data.nodeMeta ? data.nodeMeta : {});
  function basename(path) { const slash = path.lastIndexOf("/"); return slash >= 0 ? path.slice(slash + 1) : path; }
  const labelOf = $derived(mode === "function"
    ? id => nodeMeta[id]?.name ?? id
    : path => basename(path));
  const expandedLabelOf = $derived(mode === "function"
    ? id => { const m = nodeMeta[id]; return m ? `${m.name} (${basename(m.path)}:${m.line + 1})` : id; }
    : path => path);
  const edgeKey = edge => `${edge.from} ${edge.to}`;

  // When focus is set, restrict the payload to the focused node, its direct
  // neighbours, and the edges between them. buildStructureModel sees a smaller
  // graph and lays out only that.
  const focusedData = $derived.by(() => {
    if (!data || !data.graph) return data;
    const focus = appState.structureFocusPath;
    if (!focus) return data;
    const allow = new Set([focus]);
    for (const edge of data.graph.edges ?? []) {
      if (edge.from === focus || edge.to === focus) {
        allow.add(edge.from);
        allow.add(edge.to);
      }
    }
    return {
      ...data,
      graph: {
        nodes: (data.graph.nodes ?? []).filter(p => allow.has(p)),
        edges: (data.graph.edges ?? []).filter(e => allow.has(e.from) && allow.has(e.to)),
      },
      changedFiles: (data.changedFiles ?? []).filter(p => allow.has(p)),
    };
  });

  // Per-element expansion:
  //   - the focused node is shown with its full path (so the user can read
  //     exactly what was focused on)
  //   - the edge label the cursor is over expands to its full symbol list
  //   - everything else uses the compact default (basename, truncated label).
  // Hovering a node does *not* expand it — it would push the layout around and
  // is what got the previous auto-zoom attempts into trouble; the hover here
  // only dims the unrelated parts as a preview.
  let hoveredPath = $state(null);
  let hoveredEdgeKey = $state(null);
  const expandedNodes = $derived(
    appState.structureFocusPath ? new Set([appState.structureFocusPath]) : new Set(),
  );
  const expandedEdges = $derived(hoveredEdgeKey ? new Set([hoveredEdgeKey]) : new Set());
  const model = $derived.by(() => {
    if (!focusedData || !focusedData.graph) return null;
    return buildStructureModel(focusedData, { expandedNodes, expandedEdges, labelOf, expandedLabelOf });
  });

  // Lazily fetch the call graph the first time the human flips into function
  // mode (server query is expensive — bursts of LSP traffic).
  $effect(() => {
    if (appState.structureMode === "function") void ensureCallGraphLoaded();
  });

  // The set of paths/edge-keys related to the hovered node, used for dim/
  // highlight. Derived from the (possibly focused) data — when focused, only
  // edges inside the focused subgraph count.
  const related = $derived.by(() => {
    if (!hoveredPath || !focusedData || !focusedData.graph) return null;
    const paths = new Set([hoveredPath]);
    const keys = new Set();
    for (const edge of focusedData.graph.edges ?? []) {
      if (edge.from === hoveredPath || edge.to === hoveredPath) {
        paths.add(edge.from);
        paths.add(edge.to);
        keys.add(`${edge.from} ${edge.to}`);
      }
    }
    return { paths, keys };
  });
  const nodeDimmed = path => related != null && !related.paths.has(path);
  const edgeDimmed = edge => related != null && !related.keys.has(edgeKey(edge));

  // The full symbol list for the "依存の詳細" list (no tooltip on the figure
  // any more — hovering an edge label reveals the full names in place).
  function symbolsLabel(symbols) {
    if (!symbols || symbols.length === 0) return "(副作用 import のみ)";
    return `{ ${symbols.join(", ")} }`;
  }
  const edgeDetails = $derived(
    model && model.hasGraph
      ? [...model.edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
      : [],
  );

  // Manual zoom: the toolbar buttons scale the rendered SVG (the viewBox stays
  // at the model's native size so it scales crisply). The canvas has
  // `overflow: auto`, so panning a zoomed-in graph is just scrolling.
  let zoom = $state(1);
  let canvasW = $state(0);
  let canvasH = $state(0);
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 4;
  const clampZoom = z => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  function zoomBy(factor) { zoom = clampZoom(zoom * factor); }
  function fitZoom() {
    if (!model || !model.hasGraph || canvasW < 20 || canvasH < 20) return;
    zoom = clampZoom(Math.min((canvasW - 12) / model.width, (canvasH - 12) / model.height));
  }

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
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (event.shiftKey) setStructureFocus(path);
    else openFileFromStructure(path);
  }
</script>

<div class="structure-view">
  <div class="structure-toolbar">
    <span class="structure-mode">
      <label><input type="radio" name="structureMode" value="file" bind:group={appState.structureMode} /> ファイル</label>
      <label><input type="radio" name="structureMode" value="function" bind:group={appState.structureMode} /> 関数</label>
    </span>
  </div>
  {#if !data || data.loading}
    <div class="structure-message">{mode === "function" ? "コールグラフを読み込み中…（LSP が応答する間しばらくお待ちください）" : "依存グラフを読み込み中…"}</div>
  {:else if data.error}
    <div class="structure-message structure-error">読み込みに失敗しました: {data.error}</div>
  {:else if !model || !model.hasGraph}
    <div class="structure-message">
      {#if appState.structureFocusPath}
        Focus 中: <code>{appState.structureFocusPath}</code>
        にマッチするノードがグラフ内に見つかりません。
        <button type="button" class="structure-zoom-btn" onclick={() => setStructureFocus(null)}>Focus 解除</button>
      {:else if mode === "function"}
        この変更について図示できる関数呼び出しがありません。（言語サーバが起動していない、変更ファイルに関数定義がない、または callHierarchy 未対応の言語かもしれません。）
      {:else}
        この変更について図示できる import 依存関係がありません。
        （グラフ化の対象は JavaScript / TypeScript / Svelte / Go ファイル。変更ファイルが孤立しているか、import グラフ未対応の言語です。Go は worktree 直下に go.mod が無いと import を解決できません。）
      {/if}
    </div>
  {:else}
    <div class="structure-toolbar">
      <label><input type="checkbox" bind:checked={appState.structureShowSymbols} /> シンボル名を表示</label>
      {#if appState.structureFocusPath}
        <span class="structure-focus">
          Focus: <code>{appState.structureFocusPath}</code>
          <button type="button" class="structure-zoom-btn" onclick={() => setStructureFocus(null)} title="Focus を解除して全体表示に戻る">Clear focus</button>
        </span>
      {:else}
        <span class="structure-focus-hint">Shift+Click でノードを Focus（クリックはファイルへ）</span>
      {/if}
      <span class="structure-zoom">
        <button type="button" class="structure-zoom-btn" title="縮小" aria-label="Zoom out" onclick={() => zoomBy(1 / 1.25)}>−</button>
        <button type="button" class="structure-zoom-btn" title="全体に合わせる" onclick={fitZoom}>Fit</button>
        <button type="button" class="structure-zoom-btn" title="拡大" aria-label="Zoom in" onclick={() => zoomBy(1.25)}>＋</button>
        <button type="button" class="structure-zoom-btn structure-zoom-readout" title="等倍に戻す" onclick={() => (zoom = 1)}>{Math.round(zoom * 100)}%</button>
      </span>
    </div>
    <div class="structure-canvas" class:structure-focusing={related != null} bind:clientWidth={canvasW} bind:clientHeight={canvasH}>
      <svg width={model.width * zoom} height={model.height * zoom} viewBox="0 0 {model.width} {model.height}" role="img" aria-label="import dependency graph">
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
          />
        {/each}
        {#if appState.structureShowSymbols}
          {#each model.edges as edge}
            {#if edge.label}
              <g
                class="structure-edge-label"
                class:dim={edgeDimmed(edge)}
                class:expanded={edge.expanded}
                transform="translate({edge.labelX},{edge.labelY})"
                onmouseenter={() => (hoveredEdgeKey = edgeKey(edge))}
                onmouseleave={() => (hoveredEdgeKey = null)}
              >
                <rect x={-edge.labelWidth / 2} y="-8" width={edge.labelWidth} height="16" rx="3" />
                <text>{edge.label}</text>
              </g>
            {/if}
          {/each}
        {/if}
        {#each model.nodes as node (node.path)}
          {@const expanded = node.path === appState.structureFocusPath}
          {@const meta = mode === "function" ? nodeMeta[node.path] : null}
          {@const filePath = meta ? meta.path : node.path}
          {@const line = meta ? meta.line + 1 : null}
          <g
            class="structure-node"
            class:changed={node.changed}
            class:cycle={node.inCycle}
            class:dim={nodeDimmed(node.path)}
            class:expanded
            data-structure-id={node.path}
            data-structure-open={filePath}
            data-structure-line={line ?? undefined}
            transform="translate({node.x},{node.y})"
            role="button"
            tabindex="0"
            aria-label={`${node.label} — click to open, shift+click to focus`}
            onmouseenter={() => (hoveredPath = node.path)}
            onmouseleave={() => (hoveredPath = null)}
            onfocus={() => (hoveredPath = node.path)}
            onblur={() => (hoveredPath = null)}
            onkeydown={e => onNodeKeydown(e, node.path)}
          >
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
          {@const fromMeta = mode === "function" ? nodeMeta[edge.from] : null}
          {@const toMeta = mode === "function" ? nodeMeta[edge.to] : null}
          <li>
            <button
              type="button"
              class="structure-detail-file"
              class:changed={model.nodes.find(n => n.path === edge.from)?.changed}
              data-structure-id={edge.from}
              data-structure-open={fromMeta ? fromMeta.path : edge.from}
              data-structure-line={fromMeta ? fromMeta.line + 1 : undefined}
            >{labelOf(edge.from)}{fromMeta ? ` (${basename(fromMeta.path)}:${fromMeta.line + 1})` : ""}</button>
            <span class="structure-detail-arrow">→</span>
            <button
              type="button"
              class="structure-detail-file"
              class:changed={model.nodes.find(n => n.path === edge.to)?.changed}
              data-structure-id={edge.to}
              data-structure-open={toMeta ? toMeta.path : edge.to}
              data-structure-line={toMeta ? toMeta.line + 1 : undefined}
            >{labelOf(edge.to)}{toMeta ? ` (${basename(toMeta.path)}:${toMeta.line + 1})` : ""}</button>
            <span class="structure-detail-symbols">{mode === "function" ? "" : symbolsLabel(edge.symbols)}</span>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</div>
