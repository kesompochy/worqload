<script>
  // The Structure tab: an import-dependency graph of the changeset's files and
  // their neighbourhood. Click a node to *focus* on it — the canvas redraws
  // filtered to that node, its direct neighbours, and the edges between, with
  // the focused node's full path shown. Clicking another node from the focused
  // subgraph pushes a new level of focus, so the toolbar's "Back" button walks
  // one step out at a time and "Clear focus" empties the history. Shift+Click
  // opens the node in the Files tab.
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
  import {
    openFileFromStructure,
    pushStructureFocus,
    popStructureFocus,
    clearStructureFocus,
    clearStructureAnchor,
    setStructureHops,
  } from "../handlers.js";
  import { ensureCallGraphLoaded } from "../api.js";

  const anchor = $derived(appState.structureAnchor);
  const anchorPath = $derived(anchor && anchor.kind === "file" ? anchor.path : null);
  const hops = $derived(appState.structureHops);
  // The toolbar's hops selector: empty string means "let the server pick the
  // default" — selecting an integer overrides it. The Number()/null roundtrip
  // keeps state.structureHops as a number-or-null, never the empty string.
  function onHopsChange(event) {
    const raw = event.currentTarget.value;
    const next = raw === "" ? null : Number(raw);
    void setStructureHops(Number.isFinite(next) ? next : null);
  }
  function onClearAnchor() {
    void clearStructureAnchor();
  }

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

  // The focus history. Top of the stack is what the canvas is currently
  // filtered to; `null` (empty stack) shows the whole graph.
  const focusStack = $derived(appState.structureFocusStack);
  const currentFocus = $derived(focusStack.length > 0 ? focusStack[focusStack.length - 1] : null);

  // When focus is set, restrict the payload to the focused node, its direct
  // neighbours, and the edges between them. buildStructureModel sees a smaller
  // graph and lays out only that.
  const focusedData = $derived.by(() => {
    if (!data || !data.graph) return data;
    const focus = currentFocus;
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
    currentFocus ? new Set([currentFocus]) : new Set(),
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

  // The full symbol list for the "Dependencies" details panel (no tooltip on
  // the figure any more — hovering an edge label reveals the full names in
  // place).
  function symbolsLabel(symbols) {
    if (!symbols || symbols.length === 0) return "(side-effect import only)";
    return `{ ${symbols.join(", ")} }`;
  }
  const edgeDetails = $derived(
    model && model.hasGraph
      ? [...model.edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
      : [],
  );

  // Zoom: by default we fit the model to the canvas. Once the user hits
  // +/−/% (manualZoom !== null) we honour their choice for the current
  // layout; a layout change (focus push/pop, mode toggle) flips back to
  // auto-fit. The toolbar's "Fit" button also returns to auto-fit, so a
  // subsequent canvas resize re-fits.
  let manualZoom = $state(null);
  let canvasW = $state(0);
  let canvasH = $state(0);
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 4;
  const clampZoom = z => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  const fitZoomValue = $derived.by(() => {
    if (!model || !model.hasGraph || canvasW < 20 || canvasH < 20) return 1;
    return clampZoom(Math.min((canvasW - 12) / model.width, (canvasH - 12) / model.height));
  });
  const zoom = $derived(manualZoom ?? fitZoomValue);
  // A new layout (focus pushed/popped, file/function mode flipped, structure
  // reloaded) resets us to auto-fit.
  const layoutKey = $derived(`${appState.structureMode}|${focusStack.join("/")}|${model ? `${model.width}x${model.height}` : ""}`);
  $effect(() => {
    layoutKey;
    manualZoom = null;
  });
  function zoomBy(factor) { manualZoom = clampZoom(zoom * factor); }
  function fitZoom() { manualZoom = null; }

  // A short cubic between two box-edge anchor points. Forward edges (top→bottom,
  // following the import) curve gently; a back/same-layer edge bows out to the
  // right so it reads as "closes a loop" rather than running straight through
  // rows.
  function edgePath(edge) {
    const reach = Math.max(40, Math.abs(edge.y2 - edge.y1) * 0.5);
    if (edge.forward) {
      return `M${edge.x1},${edge.y1} C${edge.x1},${edge.y1 + reach} ${edge.x2},${edge.y2 - reach} ${edge.x2},${edge.y2}`;
    }
    const swing = 30 + Math.abs(edge.x2 - edge.x1) * 0.2;
    const apex = Math.max(edge.x1, edge.x2) + swing;
    return `M${edge.x1},${edge.y1} C${apex},${edge.y1} ${apex},${edge.y2} ${edge.x2},${edge.y2}`;
  }

  function onNodeKeydown(event, path) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (event.shiftKey) openFileFromStructure(path);
    else pushStructureFocus(path);
  }
</script>

<div class="structure-view">
  <div class="structure-toolbar">
    <span class="structure-mode">
      <label><input type="radio" name="structureMode" value="file" bind:group={appState.structureMode} /> Files</label>
      <label><input type="radio" name="structureMode" value="function" bind:group={appState.structureMode} /> Functions</label>
    </span>
    {#if anchorPath}
      <span class="structure-anchor-pill" title="Show in Structure からアンカー指定中">
        <span class="structure-anchor-icon" aria-hidden="true">⌘</span>
        <code>{anchorPath}</code>
        <button type="button" class="structure-anchor-clear" onclick={onClearAnchor} title="アンカーを解除して changeset 全体に戻す" aria-label="アンカー解除">×</button>
      </span>
    {/if}
    <label class="structure-hops" title="アンカーから何 hop までの依存を描くか（既定: 2）">
      hops:
      <select onchange={onHopsChange} value={hops == null ? "" : String(hops)}>
        <option value="">auto</option>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
      </select>
    </label>
  </div>
  {#if !data || data.loading}
    <div class="structure-message">{mode === "function" ? "Loading call graph… (waiting on the language server)" : "Loading dependency graph…"}</div>
  {:else if data.error}
    <div class="structure-message structure-error">Failed to load: {data.error}</div>
  {:else if !model || !model.hasGraph}
    <div class="structure-message">
      {#if currentFocus}
        No node matching <code>{currentFocus}</code> in the graph.
        <button type="button" class="structure-zoom-btn" onclick={popStructureFocus} title="Go back one focus level">Back</button>
        <button type="button" class="structure-zoom-btn" onclick={clearStructureFocus} title="Clear focus and show the whole graph">Clear focus</button>
      {:else if anchorPath}
        <code>{anchorPath}</code> から描けるグラフがありません。 (file may not be a supported source file, or its imports / dependents fall outside this worktree.)
      {:else if mode === "function"}
        No function calls to draw for this change. (The language server may not be running, the changed files may have no function definitions, or callHierarchy may not be supported for this language.)
      {:else}
        No import dependencies to draw for this change. (Supported languages: JavaScript / TypeScript / Svelte / Go. The changed files may be isolated, or the language has no import-graph support. Go imports require a go.mod at the worktree root.)
      {/if}
    </div>
  {:else}
    <div class="structure-toolbar">
      <label><input type="checkbox" bind:checked={appState.structureShowSymbols} /> Show symbol names</label>
      {#if currentFocus}
        <span class="structure-focus">
          Focus: <code>{currentFocus}</code>
          <span class="structure-focus-depth">({focusStack.length} level{focusStack.length > 1 ? "s" : ""})</span>
          <button type="button" class="structure-zoom-btn" onclick={popStructureFocus} title="Go back one focus level">Back</button>
          <button type="button" class="structure-zoom-btn" onclick={clearStructureFocus} title="Clear focus and show the whole graph">Clear focus</button>
        </span>
      {:else}
        <span class="structure-focus-hint">Click a node to focus on it · Shift+Click to open the file</span>
      {/if}
      <span class="structure-zoom">
        <button type="button" class="structure-zoom-btn" title="Zoom out" aria-label="Zoom out" onclick={() => zoomBy(1 / 1.25)}>−</button>
        <button type="button" class="structure-zoom-btn" title="Fit to canvas" onclick={fitZoom}>Fit</button>
        <button type="button" class="structure-zoom-btn" title="Zoom in" aria-label="Zoom in" onclick={() => zoomBy(1.25)}>＋</button>
        <button type="button" class="structure-zoom-btn structure-zoom-readout" title="Reset zoom to 100%" onclick={() => (manualZoom = 1)}>{Math.round(zoom * 100)}%</button>
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
          {@const expanded = node.path === currentFocus}
          {@const anchored = anchorPath != null && node.path === anchorPath}
          {@const meta = mode === "function" ? nodeMeta[node.path] : null}
          {@const filePath = meta ? meta.path : node.path}
          {@const line = meta ? meta.line + 1 : null}
          <g
            class="structure-node"
            class:changed={node.changed}
            class:cycle={node.inCycle}
            class:dim={nodeDimmed(node.path)}
            class:expanded
            class:anchored
            data-structure-id={node.path}
            data-structure-open={filePath}
            data-structure-line={line ?? undefined}
            transform="translate({node.x},{node.y})"
            role="button"
            tabindex="0"
            aria-label={`${node.label} — click to focus, shift+click to open file`}
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
      <summary>Dependencies ({edgeDetails.length})</summary>
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
