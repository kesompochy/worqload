// Pure layout for the Structure tab: turn the server's import-dependency
// payload ({ graph: { nodes, edges }, cycles, changedFiles }) into placed boxes
// and connector lines the SVG can draw. Files are laid out left→right by
// dependency depth (a file sits to the right of the files it imports); edges
// that close an import cycle are flagged so they can be drawn distinctly. The
// names each import carries become an edge label, placed between the columns
// (never on top of a node) and nudged apart from neighbouring labels.
//
// The caller can pass `{ expandedNodes, expandedEdges }` so a highlighted node
// shows its full path and a highlighted edge its full symbol list — the layout
// then widens the relevant rects and reflows everything around them. The
// frontend rebuilds the model when the hover/focus selection changes, so a
// highlighted neighborhood gets its own non-overlapping arrangement.
// No DOM, no Svelte — StructureView.svelte renders the result. (`bun test` reads
// this module without the Svelte compiler, but it uses no runes.)

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 34;
const PADDING = 18;
// Node margins (clear space around a box) are deliberately larger than label
// margins (clear space around a symbol pill): COLUMN_GAP is widened to fit the
// widest label *plus* LABEL_MARGIN on each side, and ROW_GAP > LABEL_MARGIN.
const COLUMN_GAP_MIN = 72;
const ROW_GAP = 20;
const LABEL_HEIGHT = 16;
const LABEL_MARGIN = 8;
const LABEL_MAX_CHARS = 22;
// Conservative width-per-glyph and box padding for both node text (12px) and
// label text (11px): we can't measure rendered text without a DOM, so we err
// wide so a string always fits inside its pill.
const LABEL_CHAR_WIDTH = 7.4;
const LABEL_PADDING = 14;
const NODE_CHAR_WIDTH = 7.8;
const NODE_PADDING = 16;

function baseName(path) {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

// The compact symbol-name label written onto an edge ("" for a side-effect-only
// import, which gets no label — the arrow alone says "depends on"). Long lists
// are clipped; the full list appears when the edge is in `expandedEdges`.
export function edgeLabelText(symbols, expanded = false) {
  if (!symbols || symbols.length === 0) return "";
  const joined = symbols.join(", ");
  if (expanded) return joined;
  return joined.length > LABEL_MAX_CHARS ? `${joined.slice(0, LABEL_MAX_CHARS - 1)}…` : joined;
}

export function edgeLabelWidth(text) {
  return text ? text.length * LABEL_CHAR_WIDTH + LABEL_PADDING : 0;
}

// Effective node-rect width for a given path: NODE_WIDTH unless the node is in
// `expandedNodes`, in which case it grows to fit `labelText` — defaulting to
// the full path (the import-graph view's expanded label).
export function effectiveNodeWidth(path, expanded, labelText = path) {
  if (!expanded) return NODE_WIDTH;
  return Math.max(NODE_WIDTH, labelText.length * NODE_CHAR_WIDTH + NODE_PADDING);
}

// Longest-path layering: a node's layer is 1 + the max layer of the files that
// import it (0 when nothing in the subgraph imports it). Cycles are tolerated —
// a node reached while it is still being computed contributes 0 — so members of
// an import cycle simply spread across a few layers; the back-edge that closes
// the cycle is what gets highlighted, not the layout.
function assignLayers(nodes, edges) {
  const predecessors = new Map(nodes.map(n => [n, []]));
  for (const { from, to } of edges) {
    if (from === to) continue;
    predecessors.get(to)?.push(from);
  }
  const layer = new Map();
  const inProgress = new Set();
  const compute = node => {
    if (layer.has(node)) return layer.get(node);
    if (inProgress.has(node)) return 0; // cycle guard
    inProgress.add(node);
    const preds = predecessors.get(node) ?? [];
    const value = preds.length === 0 ? 0 : 1 + Math.max(...preds.map(compute));
    inProgress.delete(node);
    layer.set(node, value);
    return value;
  };
  for (const node of nodes) compute(node);
  return layer;
}

// path -> cycle index, for the nodes that belong to an import cycle. `cycles` is
// the server's list of strongly-connected components (each a list of paths; a
// self-importing file appears as a singleton).
function cycleMembership(cycles) {
  const membership = new Map();
  (cycles ?? []).forEach((component, index) => {
    for (const path of component) membership.set(path, index);
  });
  return membership;
}

// Pull labels that share a vertical channel (same midpoint-x) apart so their
// pills don't overlap: within each channel, sort by the preferred y and bump
// each one down until it clears the previous by LABEL_HEIGHT + LABEL_MARGIN.
function deoverlapLabels(labelledEdges) {
  const channels = new Map();
  for (const edge of labelledEdges) {
    const key = Math.round(edge.labelX);
    (channels.get(key) ?? channels.set(key, []).get(key)).push(edge);
  }
  let lowestLabelBottom = 0;
  for (const channel of channels.values()) {
    channel.sort((a, b) => a.labelY - b.labelY);
    let cursor = -Infinity;
    for (const edge of channel) {
      edge.labelY = Math.max(edge.labelY, cursor + LABEL_HEIGHT + LABEL_MARGIN);
      cursor = edge.labelY;
      lowestLabelBottom = Math.max(lowestLabelBottom, edge.labelY + LABEL_HEIGHT / 2);
    }
  }
  return lowestLabelBottom;
}

const edgeKeyOf = (from, to) => `${from} ${to}`;

// Build the drawable model. `opts.expandedNodes` (Set<path>) and
// `opts.expandedEdges` (Set<"from to">) widen the corresponding rects; the
// layout reflows around them so nothing in the highlighted set overlaps.
// Returns:
//   - nodes: { path, label, x, y, width, height, changed, inCycle }
//     `width` already reflects expansion; `label` is always the basename
//     (the renderer swaps to the full path when expanded).
//   - edges: { from, to, symbols, label, labelWidth, labelX, labelY,
//     x1, y1, x2, y2, forward, inCycle, expanded } — `label`/`labelWidth`
//     already reflect expansion; `(x,y){1,2}` are box-edge anchor points.
//   - width, height: the bounding rectangle of the laid-out content.
//   - cycles: [{ paths, label }] — kept for callers that want it.
export function buildStructureModel(payload, opts = {}) {
  const graph = payload?.graph ?? { nodes: [], edges: [] };
  const nodePaths = [...(graph.nodes ?? [])];
  const rawEdges = (graph.edges ?? []).filter(e => e && nodePaths.includes(e.from) && nodePaths.includes(e.to));
  if (nodePaths.length === 0) {
    return { hasGraph: false, nodes: [], edges: [], width: 0, height: 0, cycles: [] };
  }

  const expandedNodes = opts.expandedNodes ?? new Set();
  const expandedEdges = opts.expandedEdges ?? new Set();
  // What text to render for each node in each state. The defaults — basename
  // when compact, full path when expanded — match the import-graph view; the
  // call-graph view overrides them to show function names.
  const labelOf = opts.labelOf ?? baseName;
  const expandedLabelOf = opts.expandedLabelOf ?? (path => path);
  const changedSet = new Set(payload?.changedFiles ?? payload?.changedFunctions ?? []);
  const sccOf = cycleMembership(payload?.cycles);
  const layerOf = assignLayers(nodePaths, rawEdges);

  // Effective widths up-front so the column / label sizing knows the largest
  // box it has to accommodate (an expanded node is sized for its expanded
  // label, not its compact one).
  const labelByPath = new Map(nodePaths.map(p => [p, expandedNodes.has(p) ? expandedLabelOf(p) : labelOf(p)]));
  const widthByPath = new Map(nodePaths.map(p => [p, effectiveNodeWidth(p, expandedNodes.has(p), labelByPath.get(p))]));
  const labelTextByEdge = new Map();
  const labelWidthByEdge = new Map();
  for (const edge of rawEdges) {
    const key = edgeKeyOf(edge.from, edge.to);
    const text = edgeLabelText(edge.symbols, expandedEdges.has(key));
    labelTextByEdge.set(key, text);
    labelWidthByEdge.set(key, edgeLabelWidth(text));
  }
  const widestLabel = Math.max(0, ...labelWidthByEdge.values());
  const columnGap = Math.max(COLUMN_GAP_MIN, widestLabel + 2 * LABEL_MARGIN);
  const rowPitch = NODE_HEIGHT + ROW_GAP;

  // Group by layer; within a layer, sort alphabetically so files in the same
  // directory cluster together.
  const byLayer = new Map();
  for (const path of nodePaths) {
    const layer = layerOf.get(path) ?? 0;
    (byLayer.get(layer) ?? byLayer.set(layer, []).get(layer)).push(path);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  for (const layer of layers) byLayer.get(layer).sort();

  // Per-layer column width = the widest node in that layer; layers stack
  // left-to-right with one columnGap between them.
  const columnWidth = new Map();
  for (const layer of layers) {
    const widest = Math.max(NODE_WIDTH, ...byLayer.get(layer).map(p => widthByPath.get(p)));
    columnWidth.set(layer, widest);
  }
  const layerLeft = new Map();
  let cursor = PADDING;
  for (const layer of layers) {
    layerLeft.set(layer, cursor);
    cursor += columnWidth.get(layer) + columnGap;
  }
  const totalWidth = cursor - columnGap + PADDING; // last layer doesn't trail a gap

  let maxRows = 0;
  const placed = new Map();
  for (const layer of layers) {
    const column = byLayer.get(layer);
    maxRows = Math.max(maxRows, column.length);
    const left = layerLeft.get(layer);
    const slotWidth = columnWidth.get(layer);
    column.forEach((path, row) => {
      const width = widthByPath.get(path);
      placed.set(path, {
        path,
        label: labelByPath.get(path),
        // Centre each node in its slot, so an expanded node grows symmetrically
        // and a non-expanded sibling sits in the same column on the same axis.
        x: left + (slotWidth - width) / 2,
        y: PADDING + row * rowPitch,
        width,
        height: NODE_HEIGHT,
        changed: changedSet.has(path),
        inCycle: sccOf.has(path),
      });
    });
  }

  const layoutEdges = rawEdges.map(({ from, to, symbols }) => {
    const a = placed.get(from);
    const b = placed.get(to);
    const forward = (layerOf.get(to) ?? 0) > (layerOf.get(from) ?? 0);
    const x1 = forward ? a.x + a.width : a.x;
    const y1 = a.y + a.height / 2;
    const x2 = forward ? b.x : b.x + b.width;
    const y2 = b.y + b.height / 2;
    const key = edgeKeyOf(from, to);
    return {
      from, to,
      symbols: symbols ?? [],
      x1, y1, x2, y2,
      forward,
      label: labelTextByEdge.get(key),
      labelWidth: labelWidthByEdge.get(key),
      // Preferred label position: the curve's midpoint for a forward edge,
      // lifted above the bow for a back/same-layer edge (which arcs up), but not
      // so high its pill clips the top of the canvas. deoverlapLabels may push
      // labelY further down to avoid collisions.
      labelX: (x1 + x2) / 2,
      labelY: Math.max(LABEL_HEIGHT, forward ? (y1 + y2) / 2 - 6 : Math.min(y1, y2) - 34),
      inCycle: sccOf.has(from) && sccOf.get(from) === sccOf.get(to),
      expanded: expandedEdges.has(key),
    };
  });
  const lowestLabelBottom = deoverlapLabels(layoutEdges.filter(e => e.label));

  const cycles = (payload?.cycles ?? []).map(paths => ({
    paths,
    label: paths.map(labelOf).join(paths.length > 1 ? " → " : " ↻ "),
  }));

  const nodeBottom = PADDING + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
  return {
    hasGraph: true,
    nodes: [...placed.values()],
    edges: layoutEdges,
    width: totalWidth,
    height: Math.max(nodeBottom, lowestLabelBottom) + PADDING,
    cycles,
  };
}
