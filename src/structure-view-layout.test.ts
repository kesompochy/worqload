// Layout for the Structure tab's graph. Lives under src/ so `bun test` picks it
// up (the module under test is web/structure-view.js, a plain ES module).
import { test, expect } from "bun:test";
import { buildStructureModel, NODE_WIDTH } from "../web/structure-view.js";

test("buildStructureModel reports no graph for an empty payload", () => {
  const model = buildStructureModel({ graph: { nodes: [], edges: [] }, cycles: [], changedFiles: [] });
  expect(model.hasGraph).toBe(false);
  expect(model.nodes).toEqual([]);
});

test("buildStructureModel lays files out left→right following the import arrows", () => {
  // a imports b imports c  ⇒  arrows flow a→b→c, so a is leftmost, c rightmost.
  const model = buildStructureModel({
    graph: { nodes: ["a.js", "b.js", "c.js"], edges: [{ from: "a.js", to: "b.js" }, { from: "b.js", to: "c.js" }] },
    cycles: [],
    changedFiles: ["b.js"],
  });
  const byPath = Object.fromEntries(model.nodes.map(n => [n.path, n]));
  expect(byPath["a.js"].x).toBeLessThan(byPath["b.js"].x);
  expect(byPath["b.js"].x).toBeLessThan(byPath["c.js"].x);
  expect(byPath["c.js"].x).toBe(byPath["a.js"].x + 2 * (NODE_WIDTH + 78));
  expect(byPath["b.js"].changed).toBe(true);
  expect(byPath["a.js"].changed).toBe(false);
  expect(model.edges.every(e => e.forward)).toBe(true);
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
