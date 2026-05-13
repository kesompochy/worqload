// Pure layout for the Structure tab: turn the server's import-dependency
// payload ({ graph: { nodes, edges }, cycles, changedFiles }) into placed boxes
// and connector lines the SVG can draw. Files are laid out left→right by
// dependency depth (a file sits to the right of the files it imports); edges
// that close an import cycle are flagged so they can be drawn distinctly.
// No DOM, no Svelte — StructureView.svelte renders the result. (`bun test` reads
// this module without the Svelte compiler, but it uses no runes.)

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 34;
const COLUMN_GAP = 78;
const ROW_GAP = 14;
const PADDING = 18;

function baseName(path) {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
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

// Build the drawable model. Returns `{ hasGraph, nodes, edges, width, height,
// cycles }`:
//   - nodes: { path, label, x, y, width, height, changed, inCycle }
//   - edges: { from, to, x1, y1, x2, y2, forward, inCycle } — coordinates are
//     box-edge anchor points; `forward` is false for a back/same-layer edge so
//     the renderer can route it around the column instead of straight through.
//   - cycles: [{ paths, label }] — `label` is the basenames joined for a banner.
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
        x: PADDING + layer * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + row * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        changed: changed.has(path),
        inCycle: sccOf.has(path),
      });
    });
  }

  const layoutEdges = edges.map(({ from, to }) => {
    const a = placed.get(from);
    const b = placed.get(to);
    const forward = (layerOf.get(to) ?? 0) > (layerOf.get(from) ?? 0);
    return {
      from, to,
      x1: forward ? a.x + a.width : a.x,
      y1: a.y + a.height / 2,
      x2: forward ? b.x : b.x + b.width,
      y2: b.y + b.height / 2,
      forward,
      inCycle: sccOf.has(from) && sccOf.get(from) === sccOf.get(to),
    };
  });

  const cycles = (payload?.cycles ?? []).map(paths => ({
    paths,
    label: paths.map(baseName).join(paths.length > 1 ? " → " : " ↻ "),
  }));

  const maxLayer = layers[layers.length - 1] ?? 0;
  return {
    hasGraph: true,
    nodes: [...placed.values()],
    edges: layoutEdges,
    width: PADDING * 2 + (maxLayer + 1) * NODE_WIDTH + maxLayer * COLUMN_GAP,
    height: PADDING * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP,
    cycles,
  };
}
