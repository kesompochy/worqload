// Layout for the Structure tab's graph. Lives under src/ so `bun test` picks it
// up (the module under test is web/structure-view.js, a plain ES module).
import { test, expect } from "bun:test";
import { buildStructureModel, edgeLabelText, edgeLabelWidth, effectiveNodeWidth, NODE_WIDTH, NODE_HEIGHT } from "../web/structure-view.js";

test("buildStructureModel reports no graph for an empty payload", () => {
  const model = buildStructureModel({ graph: { nodes: [], edges: [] }, cycles: [], changedFiles: [] });
  expect(model.hasGraph).toBe(false);
  expect(model.nodes).toEqual([]);
});

test("buildStructureModel lays files out top→bottom following the import arrows", () => {
  // a imports b imports c  ⇒  arrows flow a→b→c, so a is topmost, c bottommost.
  const model = buildStructureModel({
    graph: { nodes: ["a.js", "b.js", "c.js"], edges: [{ from: "a.js", to: "b.js" }, { from: "b.js", to: "c.js" }] },
    cycles: [],
    changedFiles: ["b.js"],
  });
  const byPath = Object.fromEntries(model.nodes.map(n => [n.path, n]));
  expect(byPath["a.js"].y).toBeLessThan(byPath["b.js"].y);
  expect(byPath["b.js"].y).toBeLessThan(byPath["c.js"].y);
  const rowPitch = byPath["b.js"].y - byPath["a.js"].y;
  expect(rowPitch).toBeGreaterThan(NODE_HEIGHT); // a layer gap separates the boxes
  expect(byPath["c.js"].y).toBe(byPath["a.js"].y + 2 * rowPitch);
  expect(byPath["b.js"].changed).toBe(true);
  expect(byPath["a.js"].changed).toBe(false);
  expect(model.edges.every(e => e.forward)).toBe(true);
  // Each edge carries a label anchor point at the midpoint of its run.
  const ab = model.edges.find(e => e.from === "a.js" && e.to === "b.js");
  expect(ab.labelX).toBe((ab.x1 + ab.x2) / 2);
  expect(ab.labelY).toBe((ab.y1 + ab.y2) / 2);
});

test("edgeLabelText / edgeLabelWidth: side-effect imports get no label; long lists are clipped", () => {
  expect(edgeLabelText([])).toBe("");
  expect(edgeLabelWidth("")).toBe(0);
  expect(edgeLabelText(["greet", "punctuate"])).toBe("greet, punctuate");
  expect(edgeLabelText(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]).endsWith("…")).toBe(true);
  expect(edgeLabelWidth("greet")).toBeGreaterThan(0);
});

test("buildStructureModel widens the sibling gap to fit symbol labels and writes them onto edges", () => {
  // Two siblings (a, b) in the same layer both import c — labels sit in the
  // vertical channel between rows, so the sibling gap widens to keep them
  // from crowding on x.
  const withLabels = buildStructureModel({
    graph: { nodes: ["a.js", "b.js", "c.js"], edges: [
      { from: "a.js", to: "c.js", symbols: ["aLongSymbolName", "another"] },
      { from: "b.js", to: "c.js", symbols: ["aLongSymbolName", "another"] },
    ] },
    cycles: [],
    changedFiles: [],
  });
  const withoutLabels = buildStructureModel({
    graph: { nodes: ["a.js", "b.js", "c.js"], edges: [
      { from: "a.js", to: "c.js", symbols: [] },
      { from: "b.js", to: "c.js", symbols: [] },
    ] },
    cycles: [],
    changedFiles: [],
  });
  const siblingPitch = m => m.nodes.find(n => n.path === "b.js").x - m.nodes.find(n => n.path === "a.js").x;
  expect(siblingPitch(withLabels)).toBeGreaterThan(siblingPitch(withoutLabels));
  const edge = withLabels.edges[0];
  expect(edge.label).toBe(edgeLabelText(edge.symbols));
  expect(edge.label.length).toBeGreaterThan(0);
  expect(edge.labelWidth).toBeGreaterThan(0);
});

test("buildStructureModel expands nodes / edges in `expandedNodes` / `expandedEdges` and reflows around them", () => {
  const longPath = "web/svelte/StructureView.svelte";
  const longSymbols = ["aLongSymbolName", "anotherLongOne", "yetMore"];
  const payload = {
    graph: { nodes: ["app.js", longPath], edges: [{ from: "app.js", to: longPath, symbols: longSymbols }] },
    cycles: [],
    changedFiles: [],
  };
  const collapsed = buildStructureModel(payload);
  const expanded = buildStructureModel(payload, {
    expandedNodes: new Set([longPath]),
    expandedEdges: new Set(["app.js " + longPath]),
  });
  const longNode = p => p.nodes.find(n => n.path === longPath);
  expect(longNode(collapsed).width).toBe(NODE_WIDTH);
  expect(longNode(expanded).width).toBe(effectiveNodeWidth(longPath, true));
  expect(longNode(expanded).width).toBeGreaterThan(NODE_WIDTH);
  // The expanded edge carries the full symbol text and a correspondingly wider pill.
  const edge = e => e.edges.find(x => x.from === "app.js" && x.to === longPath);
  expect(edge(collapsed).label.endsWith("…")).toBe(true);
  expect(edge(expanded).label).toBe(longSymbols.join(", "));
  expect(edge(expanded).labelWidth).toBeGreaterThan(edge(collapsed).labelWidth);
  // The canvas grows so the expanded box and label have room.
  expect(expanded.width).toBeGreaterThan(collapsed.width);
});

test("buildStructureModel keeps labels in the same horizontal channel from overlapping", () => {
  // b.js and c.js (same layer, side-by-side siblings) both import d.js — their
  // edge labels sit at the same midpoint-y and must not overlap on x.
  const model = buildStructureModel({
    graph: {
      nodes: ["b.js", "c.js", "d.js"],
      edges: [
        { from: "b.js", to: "d.js", symbols: ["fromB"] },
        { from: "c.js", to: "d.js", symbols: ["fromC"] },
      ],
    },
    cycles: [],
    changedFiles: [],
  });
  const eb = model.edges.find(e => e.from === "b.js");
  const ec = model.edges.find(e => e.from === "c.js");
  expect(eb.labelY).toBe(ec.labelY);
  const minSeparation = (eb.labelWidth + ec.labelWidth) / 2;
  expect(Math.abs(ec.labelX - eb.labelX)).toBeGreaterThanOrEqual(minSeparation);
});

test("buildStructureModel uses the file's basename as the node label", () => {
  const model = buildStructureModel({
    graph: { nodes: ["web/svelte/Foo.svelte"], edges: [] },
    cycles: [],
    changedFiles: [],
  });
  expect(model.nodes[0].label).toBe("Foo.svelte");
});

test("buildStructureModel flags cycle nodes and the back-edge that closes the cycle", () => {
  const model = buildStructureModel({
    graph: {
      nodes: ["a.js", "b.js", "c.js", "d.js"],
      edges: [
        { from: "a.js", to: "b.js" },
        { from: "b.js", to: "c.js" },
        { from: "c.js", to: "a.js" }, // closes the a→b→c→a cycle
        { from: "d.js", to: "a.js" }, // not part of the cycle
      ],
    },
    cycles: [["a.js", "b.js", "c.js"]],
    changedFiles: [],
  });
  const byPath = Object.fromEntries(model.nodes.map(n => [n.path, n]));
  expect(byPath["a.js"].inCycle).toBe(true);
  expect(byPath["d.js"].inCycle).toBe(false);
  const cycleEdges = model.edges.filter(e => e.inCycle).map(e => `${e.from}->${e.to}`).sort();
  expect(cycleEdges).toEqual(["a.js->b.js", "b.js->c.js", "c.js->a.js"]);
  expect(model.edges.find(e => e.from === "d.js").inCycle).toBe(false);
  expect(model.cycles).toEqual([{ paths: ["a.js", "b.js", "c.js"], label: "a.js → b.js → c.js" }]);
});

test("buildStructureModel does not loop forever on a cyclic subgraph with no acyclic root", () => {
  const model = buildStructureModel({
    graph: { nodes: ["x.js", "y.js"], edges: [{ from: "x.js", to: "y.js" }, { from: "y.js", to: "x.js" }] },
    cycles: [["x.js", "y.js"]],
    changedFiles: ["x.js"],
  });
  expect(model.hasGraph).toBe(true);
  expect(model.nodes.map(n => n.path).sort()).toEqual(["x.js", "y.js"]);
});
