<script>
  // One Structure-tab canvas: laid-out nodes + edges drawn into an SVG, with
  // its own hover state and manual zoom. Sibling of StructureView.svelte; the
  // outer view passes in the payload (`data`), the mode (which decides node-
  // label vs. file-path labelling), and a few flags it would otherwise have to
  // duplicate per side. The split (Before | After) view mounts two of these
  // canvases under one shared toolbar.
  //
  // The canvas does NOT own focus, anchor, hops, or the Show-symbols toggle —
  // those are shared across sides and live in `appState`. Hover, zoom, and
  // scroll DO stay local: dimming the unrelated half of the Before graph when
  // the cursor is over the After graph would be confusing.
  import { state as appState } from "../state.svelte.js";
  import { buildStructureModel, zoomAroundCursor } from "../structure-view.js";
  import { openFileFromStructure, pushStructureFocus } from "../handlers.js";

  let { data, mode, showSymbols, labelOf, expandedLabelOf, anchored, label = "" } = $props();

  const nodeMeta = $derived(data && data.nodeMeta ? data.nodeMeta : {});
  const edgeKey = edge => `${edge.from} ${edge.to}`;

  const focusStack = $derived(appState.structureFocusStack);
  const currentFocus = $derived(focusStack.length > 0 ? focusStack[focusStack.length - 1] : null);

  // Same focus restriction StructureView does pre-extract: keep the focused
  // node, its direct neighbours, and the edges between. A side with no node
  // matching the focus falls back to its own empty state below.
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

  let hoveredPath = $state(null);
  let hoveredEdgeKey = $state(null);
  const expandedNodes = $derived(currentFocus ? new Set([currentFocus]) : new Set());
  const expandedEdges = $derived(hoveredEdgeKey ? new Set([hoveredEdgeKey]) : new Set());
  const model = $derived.by(() => {
    if (!focusedData || !focusedData.graph) return null;
    return buildStructureModel(focusedData, { expandedNodes, expandedEdges, labelOf, expandedLabelOf });
  });

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

  // Zoom (per canvas — Before and After are scaled independently). Same auto-
  // fit-until-manual rule the single-canvas view used: a layout change snaps
  // back to fit; +/−/% sticks until the layout changes again.
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
  const layoutKey = $derived(`${mode}|${focusStack.join("/")}|${model ? `${model.width}x${model.height}` : ""}`);
  $effect(() => {
    layoutKey;
    manualZoom = null;
  });
  function zoomBy(factor) { manualZoom = clampZoom(zoom * factor); }
  function fitZoom() { manualZoom = null; }

  let canvasEl = $state();
  $effect(() => {
    const el = canvasEl;
    if (!el) return;
    function applyZoom(nextZoom, clientX, clientY) {
      const oldZoom = zoom;
      const target = clampZoom(nextZoom);
      if (target === oldZoom) return;
      const rect = el.getBoundingClientRect();
      const cursorX = clientX - rect.left;
      const cursorY = clientY - rect.top;
      const newScrollLeft = zoomAroundCursor(el.scrollLeft, cursorX, oldZoom, target);
      const newScrollTop = zoomAroundCursor(el.scrollTop, cursorY, oldZoom, target);
      manualZoom = target;
      requestAnimationFrame(() => {
        el.scrollLeft = newScrollLeft;
        el.scrollTop = newScrollTop;
      });
    }
    function onWheel(event) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      applyZoom(zoom * Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
    }
    let gestureBaseZoom = null;
    function onGestureStart(event) {
      event.preventDefault();
      gestureBaseZoom = zoom;
    }
    function onGestureChange(event) {
      event.preventDefault();
      if (gestureBaseZoom == null) return;
      applyZoom(gestureBaseZoom * event.scale, event.clientX, event.clientY);
    }
    function onGestureEnd() { gestureBaseZoom = null; }
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  });

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

<div class="structure-canvas-frame">
  {#if label}
    <div class="structure-canvas-label">{label}</div>
  {/if}
  {#if !data || data.loading}
    <div class="structure-message">{mode === "function" ? "Loading call graph…" : "Loading dependency graph…"}</div>
  {:else if data.error}
    <div class="structure-message structure-error">Failed to load: {data.error}</div>
  {:else if !model || !model.hasGraph}
    <div class="structure-message">No graph to draw for this {label || "side"}.</div>
  {:else}
    <div class="structure-zoom">
      <button type="button" class="structure-zoom-btn" title="Zoom out" aria-label="Zoom out" onclick={() => zoomBy(1 / 1.25)}>−</button>
      <button type="button" class="structure-zoom-btn" title="Fit to canvas" onclick={fitZoom}>Fit</button>
      <button type="button" class="structure-zoom-btn" title="Zoom in" aria-label="Zoom in" onclick={() => zoomBy(1.25)}>＋</button>
      <button type="button" class="structure-zoom-btn structure-zoom-readout" title="Reset zoom to 100%" onclick={() => (manualZoom = 1)}>{Math.round(zoom * 100)}%</button>
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
        {#if showSymbols}
          {#each model.edges as edge}
            {#if edge.label}
              <g
                class="structure-edge-label"
                class:dim={edgeDimmed(edge)}
                class:expanded={edge.expanded}
                role="presentation"
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
          {@const isAnchored = anchored(node.path)}
          {@const meta = mode === "function" ? nodeMeta[node.path] : null}
          {@const filePath = meta ? meta.path : node.path}
          {@const line = meta ? meta.line + 1 : null}
          <g
            class="structure-node"
            class:changed={node.changed}
            class:cycle={node.inCycle}
            class:dim={nodeDimmed(node.path)}
            class:expanded
            class:anchored={isAnchored}
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
  {/if}
</div>
