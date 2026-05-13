<script>
  // The Structure tab: an import-dependency graph of the changeset's files and
  // their immediate neighborhood (the files they import / that import them).
  // Import cycles show up as dashed red edges (and red node borders); the names
  // each import carries are written onto the edges (toggleable). Hovering or
  // focusing a node highlights it, its direct neighbours, and the connecting
  // edges, *re-flows the layout* around the expanded sizes (so the highlighted
  // group never overlaps with itself), and — unless the human turned auto-zoom
  // off — zooms and pans the canvas so that group fills the visible area. The
  // pre-hover view is remembered; un-hovering restores it.
  //
  // Mounted by DetailBody when the Structure tab is active. The data comes from
  // GET /sessions/:id/structure (held in appState.structure); buildStructureModel
  // places the boxes and connectors, this draws the SVG. Nodes carry
  // `data-structure-open`, so a click is picked up by DetailBody's delegated
  // handler (which opens the file in the Files tab); keyboard activation
  // (Enter/Space on a focused node) is handled here.
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState } from "../state.svelte.js";
  import { buildStructureModel } from "../structure-view.js";
  import { openFileFromStructure } from "../handlers.js";

  const data = $derived(appState.structure);
  const edgeKey = edge => `${edge.from} ${edge.to}`;

  // What the human is currently directing attention at. `hoveredPath` is the
  // node under the cursor or focus; `hoveredEdgeKey` is an edge label being
  // hovered on its own (a label-only hover expands just that label, while a
  // node hover expands the node, its neighbours, and the edges between).
  let hoveredPath = $state(null);
  let hoveredEdgeKey = $state(null);

  // The set of paths and edge-keys related to the hovered node. Derived from
  // the raw payload — not from `model` — so it doesn't depend on the model that
  // itself depends on it (a `data → related → model → related` loop).
  const related = $derived.by(() => {
    if (!hoveredPath || !data || !data.graph) return null;
    const paths = new Set([hoveredPath]);
    const keys = new Set();
    for (const edge of data.graph.edges ?? []) {
      if (edge.from === hoveredPath || edge.to === hoveredPath) {
        paths.add(edge.from);
        paths.add(edge.to);
        keys.add(`${edge.from} ${edge.to}`);
      }
    }
    return { paths, keys };
  });
  const expandedNodes = $derived(related?.paths ?? new Set());
  const expandedEdges = $derived.by(() => {
    const s = new Set(related?.keys ?? []);
    if (hoveredEdgeKey) s.add(hoveredEdgeKey);
    return s;
  });
  // The layout reflows when either expansion set changes — buildStructureModel
  // uses them to widen the relevant rects and pull the surrounding columns
  // outwards so the highlighted neighbourhood lays out without overlap.
  const model = $derived.by(() => {
    if (!data || !data.graph) return null;
    return buildStructureModel(data, { expandedNodes, expandedEdges });
  });

  const nodeDimmed = path => related != null && !related.paths.has(path);
  const edgeDimmed = edge => related != null && !related.keys.has(edgeKey(edge));

  // The full symbol list for the "依存の詳細" list (no tooltip on the figure
  // any more — hovering an edge label or a node reveals the full names in place).
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
  // `overflow: auto`, so panning a zoomed-in graph is just scrolling. Auto-zoom
  // drives the same `zoom` plus `canvasEl.scrollLeft/Top` via a RAF tween.
  let zoom = $state(1);
  let canvasW = $state(0);
  let canvasH = $state(0);
  let canvasEl = $state(null);
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 4;
  const clampZoom = z => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  function zoomBy(factor) { cancelTween(); zoom = clampZoom(zoom * factor); }
  function fitZoom() {
    cancelTween();
    if (!model || !model.hasGraph || canvasW < 20 || canvasH < 20) return;
    const fit = Math.min((canvasW - 12) / model.width, (canvasH - 12) / model.height);
    zoom = clampZoom(fit);
  }

  // Auto-zoom on highlight: when the human starts hovering a node we save the
  // current view, tween to a view that fits the highlighted neighbourhood, and
  // tween back when the hover ends. A 500ms easeInOutQuad RAF on `zoom` and the
  // canvas's scroll position — Svelte re-renders the SVG on each `zoom` change.
  const TWEEN_MS = 500;
  let rafId = null;
  let savedView = null;
  let lastHoverActive = false;
  function cancelTween() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }
  function tweenView(targetZoom, targetScrollX, targetScrollY) {
    cancelTween();
    const startZoom = zoom;
    const startScrollX = canvasEl?.scrollLeft ?? 0;
    const startScrollY = canvasEl?.scrollTop ?? 0;
    const startTime = performance.now();
    const step = now => {
      const raw = Math.min(1, (now - startTime) / TWEEN_MS);
      const t = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
      zoom = startZoom + (targetZoom - startZoom) * t;
      if (canvasEl) {
        canvasEl.scrollLeft = startScrollX + (targetScrollX - startScrollX) * t;
        canvasEl.scrollTop = startScrollY + (targetScrollY - startScrollY) * t;
      }
      if (raw < 1) rafId = requestAnimationFrame(step);
      else rafId = null;
    };
    rafId = requestAnimationFrame(step);
  }
  // The view that fits the currently-highlighted neighbourhood inside the
  // canvas, with a bit of breathing room. `related` is the source of truth for
  // which nodes (and their edges' labels) should be in frame.
  function viewForHighlight() {
    if (!model || !related || canvasW < 20 || canvasH < 20) return null;
    const focused = model.nodes.filter(n => related.paths.has(n.path));
    if (focused.length === 0) return null;
    const pad = 40;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of focused) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    for (const e of model.edges) {
      if (!related.keys.has(edgeKey(e)) || !e.label) continue;
      minX = Math.min(minX, e.labelX - e.labelWidth / 2);
      maxX = Math.max(maxX, e.labelX + e.labelWidth / 2);
      minY = Math.min(minY, e.labelY - 10);
      maxY = Math.max(maxY, e.labelY + 10);
    }
    const w = maxX - minX, h = maxY - minY;
    const targetZoom = clampZoom(Math.min((canvasW - pad * 2) / w, (canvasH - pad * 2) / h));
    const scrollX = minX * targetZoom - (canvasW - w * targetZoom) / 2;
    const scrollY = minY * targetZoom - (canvasH - h * targetZoom) / 2;
    return { zoom: targetZoom, scrollX: Math.max(0, scrollX), scrollY: Math.max(0, scrollY) };
  }

  // Trigger the auto-zoom transitions on hover changes. Runs after the model
  // has re-derived, so `viewForHighlight()` uses the expanded layout.
  $effect(() => {
    const active = hoveredPath != null;
    if (!appState.structureAutoZoom) {
      // The toggle was flipped off mid-hover: snap back to the saved view.
      if (savedView && !active) {
        tweenView(savedView.zoom, savedView.scrollX, savedView.scrollY);
        savedView = null;
      }
      lastHoverActive = active;
      return;
    }
    if (active && !lastHoverActive) {
      savedView = { zoom, scrollX: canvasEl?.scrollLeft ?? 0, scrollY: canvasEl?.scrollTop ?? 0 };
      const target = viewForHighlight();
      if (target) tweenView(target.zoom, target.scrollX, target.scrollY);
    } else if (active && lastHoverActive) {
      const target = viewForHighlight();
      if (target) tweenView(target.zoom, target.scrollX, target.scrollY);
    } else if (!active && lastHoverActive) {
      if (savedView) {
        tweenView(savedView.zoom, savedView.scrollX, savedView.scrollY);
        savedView = null;
      }
    }
    lastHoverActive = active;
  });

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
      <label><input type="checkbox" bind:checked={appState.structureAutoZoom} /> 強調時に自動ズーム</label>
      <span class="structure-zoom">
        <button type="button" class="structure-zoom-btn" title="縮小" aria-label="Zoom out" onclick={() => zoomBy(1 / 1.25)}>−</button>
        <button type="button" class="structure-zoom-btn" title="全体に合わせる" onclick={fitZoom}>Fit</button>
        <button type="button" class="structure-zoom-btn" title="拡大" aria-label="Zoom in" onclick={() => zoomBy(1.25)}>＋</button>
        <button type="button" class="structure-zoom-btn structure-zoom-readout" title="等倍に戻す" onclick={() => { cancelTween(); zoom = 1; }}>{Math.round(zoom * 100)}%</button>
      </span>
    </div>
    <div class="structure-canvas" class:structure-focusing={related != null} bind:this={canvasEl} bind:clientWidth={canvasW} bind:clientHeight={canvasH}>
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
          {@const expanded = related != null && related.paths.has(node.path)}
          <g
            class="structure-node"
            class:changed={node.changed}
            class:cycle={node.inCycle}
            class:dim={nodeDimmed(node.path)}
            class:expanded
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
            <rect width={node.width} height={node.height} rx="5" />
            <text x={node.width / 2} y={node.height / 2}>{expanded ? node.path : node.label}</text>
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
