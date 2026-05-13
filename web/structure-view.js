// Pure layout for the Structure tab: turn the server's import-dependency
// payload ({ graph: { nodes, edges }, cycles, changedFiles }) into placed boxes
// and connector lines the SVG can draw. Files are laid out left→right by
// dependency depth (a file sits to the right of the files it imports); edges
// that close an import cycle are flagged so they can be drawn distinctly. The
// names each import carries become an edge label, placed between the columns
// (never on top of a node) and nudged apart from neighbouring labels.
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
// Conservative width-per-glyph at 11px monospace and box padding: we can't
// measure rendered text without a DOM, so we err wide so a label always fits
// inside its pill (the alternative — text overflowing the rect — is the bug
// these constants exist to prevent).
const LABEL_CHAR_WIDTH = 7.4;
const LABEL_PADDING = 14;

function baseName(path) {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

// The compact symbol-name label written onto an edge ("" for a side-effect-only
// import, which gets no label — the arrow alone says "depends on"). Long lists
// are clipped; the full list lives in the edge's tooltip / the details list.
export function edgeLabelText(symbols) {
  if (!symbols || symbols.length === 0) return "";
  const joined = symbols.join(", ");
  return joined.length > LABEL_MAX_CHARS ? `${joined.slice(0, LABEL_MAX_CHARS - 1)}…` : joined;
}

export function edgeLabelWidth(text) {
  return text ? text.length * LABEL_CHAR_WIDTH + LABEL_PADDING : 0;
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

// Build the drawable model. Returns `{ hasGraph, nodes, edges, width, height,
// cycles }`:
//   - nodes: { path, label, x, y, width, height, changed, inCycle }
//   - edges: { from, to, symbols, label, labelWidth, labelX, labelY,
//     x1, y1, x2, y2, forward, inCycle } — the {x,y}{1,2} are box-edge anchor
//     points; `forward` is false for a back/same-layer edge so the renderer can
//     route it around the column instead of straight through.
//   - cycles: [{ paths, label }] — basenames joined; kept for callers that want it.
export function buildStructureModel(payload) {
  const graph = payload?.graph ?? { nodes: [], edges: [] };
  const nodePaths = [...(graph.nodes ?? [])];
  const edges = (graph.edges ?? []).filter(e => e && nodePaths.includes(e.from) && nodePaths.includes(e.to));
  if (nodePaths.length === 0) {
    return { hasGraph: false, nodes: [], edges: [], width: 0, height: 0, cycles: [] };
  }

  const changed = new Set(payload?.changedFiles ?? []);
  const sccOf = cycleMembership(payload?.cycles);
  const layerOf = assignLayers(nodePaths, edges);

  // Widen the inter-column gap so the widest label fits between two columns with
  // a LABEL_MARGIN to spare on each side — that keeps labels off the nodes.
  const widestLabel = Math.max(0, ...edges.map(e => edgeLabelWidth(edgeLabelText(e.symbols))));
  const columnGap = Math.max(COLUMN_GAP_MIN, widestLabel + 2 * LABEL_MARGIN);
  const columnPitch = NODE_WIDTH + columnGap;
  const rowPitch = NODE_HEIGHT + ROW_GAP;

  // Group by layer, then order within a layer alphabetically (stable, and keeps
  // a file near the others in its directory).
  const byLayer = new Map();
  for (const path of nodePaths) {
    const layer = layerOf.get(path) ?? 0;
    (byLayer.get(layer) ?? byLayer.set(layer, []).get(layer)).push(path);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  let maxRows = 0;
  const placed = new Map();
  for (const layer of layers) {
    const column = byLayer.get(layer).sort();
    maxRows = Math.max(maxRows, column.length);
    column.forEach((path, row) => {
      placed.set(path, {
        path,
        label: baseName(path),
        x: PADDING + layer * columnPitch,
        y: PADDING + row * rowPitch,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        changed: changed.has(path),
        inCycle: sccOf.has(path),
      });
    });
  }

  const layoutEdges = edges.map(({ from, to, symbols }) => {
    const a = placed.get(from);
    const b = placed.get(to);
    const forward = (layerOf.get(to) ?? 0) > (layerOf.get(from) ?? 0);
    const x1 = forward ? a.x + a.width : a.x;
    const y1 = a.y + a.height / 2;
    const x2 = forward ? b.x : b.x + b.width;
    const y2 = b.y + b.height / 2;
    const text = edgeLabelText(symbols);
    return {
      from, to,
      symbols: symbols ?? [],
      x1, y1, x2, y2,
      forward,
      label: text,
      labelWidth: edgeLabelWidth(text),
      // Preferred label position: the curve's midpoint for a forward edge,
      // lifted above the bow for a back/same-layer edge (which arcs up), but not
      // so high its pill clips the top of the canvas. deoverlapLabels may push
      // labelY further down to avoid collisions.
      labelX: (x1 + x2) / 2,
      labelY: Math.max(LABEL_HEIGHT, forward ? (y1 + y2) / 2 - 6 : Math.min(y1, y2) - 34),
      inCycle: sccOf.has(from) && sccOf.get(from) === sccOf.get(to),
    };
  });
  const lowestLabelBottom = deoverlapLabels(layoutEdges.filter(e => e.label));

  const cycles = (payload?.cycles ?? []).map(paths => ({
    paths,
    label: paths.map(baseName).join(paths.length > 1 ? " → " : " ↻ "),
  }));

  const maxLayer = layers[layers.length - 1] ?? 0;
  const nodeHeight = PADDING + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
  return {
    hasGraph: true,
    nodes: [...placed.values()],
    edges: layoutEdges,
    width: PADDING * 2 + (maxLayer + 1) * NODE_WIDTH + maxLayer * columnGap,
    height: Math.max(nodeHeight, lowestLabelBottom) + PADDING,
    cycles,
  };
}
