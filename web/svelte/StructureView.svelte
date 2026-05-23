<script>
  // The Structure tab: an import-dependency graph of the changeset's files and
  // their neighbourhood. Click a node to *focus* on it — the canvas redraws
  // filtered to that node, its direct neighbours, and the edges between, with
  // the focused node's full path shown. Clicking another node from the focused
  // subgraph pushes a new level of focus, so the toolbar's "Back" button walks
  // one step out at a time and "Clear focus" empties the history. Shift+Click
  // opens the node in the Files tab.
  //
  // The Split toggle adds a Before / After comparison: a second canvas to the
  // left renders the same graph computed against the diff base, so the human
  // can see how the import structure changed (new files, removed edges, …).
  // Only file mode supports it — the LSP-driven call graph has no diff-base
  // counterpart, so split is hidden in function mode. Both canvases share the
  // anchor, hops, and focus; hover and zoom stay per-side.
  //
  // Mounted by DetailBody when the Structure tab is active. The data comes
  // from GET /sessions/:id/structure (held in appState.structure / .structureBefore);
  // StructureCanvas.svelte does the per-side layout + drawing. Nodes carry
  // `data-structure-open`, so click/shift-click handling is in
  // onDetailBodyClick's delegated handler (web/handlers.js).
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState } from "../state.svelte.js";
  import {
    popStructureFocus,
    clearStructureFocus,
    clearStructureAnchor,
    setStructureHops,
    setStructureMode,
    setStructureSplit,
  } from "../handlers.js";
  import StructureCanvas from "./StructureCanvas.svelte";

  const anchor = $derived(appState.structureAnchor);
  const anchorPath = $derived(anchor?.path ?? null);
  const anchorLine = $derived(anchor?.kind === "symbol" ? anchor.line : null);
  const anchorPillLabel = $derived(
    anchorPath == null ? "" : (anchorLine != null ? `${anchorPath}:${anchorLine}` : anchorPath)
  );
  const hops = $derived(appState.structureHops);
  function onHopsChange(event) {
    const raw = event.currentTarget.value;
    const next = raw === "" ? null : Number(raw);
    void setStructureHops(Number.isFinite(next) ? next : null);
  }
  function onClearAnchor() { void clearStructureAnchor(); }
  function onSplitChange(event) { void setStructureSplit(event.currentTarget.checked); }

  const mode = $derived(appState.structureMode);
  const split = $derived(appState.structureSplit);
  const afterData = $derived(mode === "function" ? appState.callGraph : appState.structure);
  // The Before snapshot is fetched eagerly for both modes (api.js's
  // ensureStructureViewLoaded). Toggling Split flips visibility, not fetching.
  const beforeData = $derived(mode === "function" ? appState.callGraphBefore : appState.structureBefore);
  // The Dependencies panel reads from whichever side the After-style canvas is
  // showing — the current state of the world. In split mode the Before side
  // gets its own canvas-internal node/edge listing implicitly via the SVG; the
  // sidebar list is too noisy doubled, so it stays After-only.
  const panelData = $derived(afterData);
  const nodeMeta = $derived(panelData && panelData.nodeMeta ? panelData.nodeMeta : {});
  function basename(path) { const slash = path.lastIndexOf("/"); return slash >= 0 ? path.slice(slash + 1) : path; }
  const labelOf = $derived(mode === "function"
    ? id => nodeMeta[id]?.name ?? id
    : path => basename(path));
  const expandedLabelOf = $derived(mode === "function"
    ? id => { const m = nodeMeta[id]; return m ? `${m.name} (${basename(m.path)}:${m.line + 1})` : id; }
    : path => path);

  const focusStack = $derived(appState.structureFocusStack);
  const currentFocus = $derived(focusStack.length > 0 ? focusStack[focusStack.length - 1] : null);

  function isAnchoredNode(nodeId) {
    if (anchorPath == null) return false;
    if (mode === "function") {
      const meta = nodeMeta[nodeId];
      if (!meta || meta.path !== anchorPath) return false;
      if (anchorLine == null) return true;
      return meta.line === anchorLine - 1;
    }
    return nodeId === anchorPath;
  }

  // The "any side has a drawable graph" gate, used to decide whether to show
  // the focus / details strip. In split mode either side counts — a brand-new
  // file appears only in After, a deleted file only in Before; either alone is
  // worth showing.
  const afterHasGraph = $derived(afterData && afterData.graph && (afterData.graph.nodes?.length ?? 0) > 0);
  const beforeHasGraph = $derived(beforeData && beforeData.graph && (beforeData.graph.nodes?.length ?? 0) > 0);
  const anyHasGraph = $derived(afterHasGraph || (split && beforeHasGraph));
  const showFatalMessage = $derived(!afterData || afterData.loading || afterData.error || (!anyHasGraph && !split));

  function symbolsLabel(symbols) {
    if (!symbols || symbols.length === 0) return "(side-effect import only)";
    return `{ ${symbols.join(", ")} }`;
  }
  const edgeDetails = $derived.by(() => {
    if (!panelData || !panelData.graph) return [];
    const edges = panelData.graph.edges ?? [];
    return [...edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  });
  const changedSet = $derived(new Set(panelData?.changedFiles ?? []));
  function isChanged(nodeId) {
    if (mode === "function") {
      const meta = nodeMeta[nodeId];
      return meta ? changedSet.has(meta.path) : false;
    }
    return changedSet.has(nodeId);
  }
</script>

<div class="structure-view" class:structure-view-split={split}>
  <div class="structure-toolbar">
    <span class="structure-mode">
      <label><input type="radio" name="structureMode" value="file" checked={appState.structureMode === "file"} onchange={() => setStructureMode("file")} /> Files</label>
      <label><input type="radio" name="structureMode" value="function" checked={appState.structureMode === "function"} onchange={() => setStructureMode("function")} /> Functions</label>
    </span>
    <label class="structure-split-toggle" title="Before（diff base 時点）と After（現在の worktree）のグラフを左右で比較する。 Before は タブを開いた瞬間に裏で読み込み始める。">
      <input type="checkbox" checked={appState.structureSplit} onchange={onSplitChange} />
      Before / After split
    </label>
    {#if anchorPath}
      <span class="structure-anchor-pill" title={anchorLine != null ? "Show in Structure からシンボルアンカー指定中" : "Show in Structure からファイルアンカー指定中"}>
        <span class="structure-anchor-icon" aria-hidden="true">⌘</span>
        <code>{anchorPillLabel}</code>
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

  {#if showFatalMessage}
    <div class="structure-message" class:structure-error={afterData?.error}>
      {#if !afterData || afterData.loading}
        {mode === "function" ? "Loading call graph… (waiting on the language server)" : "Loading dependency graph…"}
      {:else if afterData.error}
        Failed to load: {afterData.error}
      {:else if currentFocus}
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
    </div>

    <div class="structure-canvas-row" class:structure-canvas-row-split={split}>
      {#if split}
        <StructureCanvas
          data={beforeData}
          mode={mode}
          showSymbols={appState.structureShowSymbols}
          labelOf={labelOf}
          expandedLabelOf={expandedLabelOf}
          anchored={isAnchoredNode}
          label="Before"
        />
        <StructureCanvas
          data={afterData}
          mode={mode}
          showSymbols={appState.structureShowSymbols}
          labelOf={labelOf}
          expandedLabelOf={expandedLabelOf}
          anchored={isAnchoredNode}
          label="After"
        />
      {:else}
        <StructureCanvas
          data={afterData}
          mode={mode}
          showSymbols={appState.structureShowSymbols}
          labelOf={labelOf}
          expandedLabelOf={expandedLabelOf}
          anchored={isAnchoredNode}
        />
      {/if}
    </div>

    <details class="structure-details">
      <summary>Dependencies ({edgeDetails.length}){split ? " — After のみ" : ""}</summary>
      <ul>
        {#each edgeDetails as edge}
          {@const fromMeta = mode === "function" ? nodeMeta[edge.from] : null}
          {@const toMeta = mode === "function" ? nodeMeta[edge.to] : null}
          <li>
            <button
              type="button"
              class="structure-detail-file"
              class:changed={isChanged(edge.from)}
              data-structure-id={edge.from}
              data-structure-open={fromMeta ? fromMeta.path : edge.from}
              data-structure-line={fromMeta ? fromMeta.line + 1 : undefined}
            >{labelOf(edge.from)}{fromMeta ? ` (${basename(fromMeta.path)}:${fromMeta.line + 1})` : ""}</button>
            <span class="structure-detail-arrow">→</span>
            <button
              type="button"
              class="structure-detail-file"
              class:changed={isChanged(edge.to)}
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
