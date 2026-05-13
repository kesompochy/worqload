import { test, expect } from "bun:test";
import { buildCallGraphView, uriToRelPath, nodeFromItem } from "./call-graph";
import { LSP_SYMBOL_KIND_FUNCTION, LSP_SYMBOL_KIND_METHOD, type CallHierarchyItem } from "./lsp-client";

const ROOT = "/work/tree";

function range(line: number, ch = 0) {
  return { start: { line, character: ch }, end: { line, character: ch + 5 } };
}
function item(relPath: string, name: string, line: number, kind = LSP_SYMBOL_KIND_FUNCTION): CallHierarchyItem {
  return {
    name,
    kind,
    uri: `file://${ROOT}/${relPath}`,
    range: range(line),
    selectionRange: range(line),
  };
}

test("uriToRelPath strips a file:// prefix and the worktree root", () => {
  expect(uriToRelPath("file:///work/tree/src/a.ts", ROOT)).toBe("src/a.ts");
  expect(uriToRelPath("file:///work/tree", ROOT)).toBe("");
  expect(uriToRelPath("file:///other/place/a.ts", ROOT)).toBeNull();
  expect(uriToRelPath("not-a-uri", ROOT)).toBeNull();
});

test("nodeFromItem builds an id from the selectionRange + name and drops items outside the worktree", () => {
  const inside = item("src/a.ts", "doStuff", 12);
  const outside = item("../elsewhere.ts", "elsewhere", 0);
  outside.uri = "file:///somewhere/else.ts";
  expect(nodeFromItem(inside, ROOT)?.id).toBe("src/a.ts:12:0:doStuff");
  expect(nodeFromItem(outside, ROOT)).toBeNull();
});

test("buildCallGraphView seeds from changed files and adds one-hop incoming/outgoing edges", async () => {
  // Two changed files, four total functions:
  //   src/changed/greet.ts:  greet (3), say (10)
  //   src/changed/util.ts:   punct (5)
  //   src/other/app.ts:      run (1)   ← reached only via callHierarchy
  const greet = item("src/changed/greet.ts", "greet", 3);
  const say = item("src/changed/greet.ts", "say", 10);
  const punct = item("src/changed/util.ts", "punct", 5);
  const run = item("src/other/app.ts", "run", 1);

  const symbols = (sym: CallHierarchyItem) => [
    { name: sym.name, kind: sym.kind, range: sym.range, selectionRange: sym.selectionRange },
  ];

  const view = await buildCallGraphView({
    rootAbsPath: ROOT,
    changedFiles: ["src/changed/greet.ts", "src/changed/util.ts"],
    async documentSymbol(rel) {
      if (rel === "src/changed/greet.ts") return [
        { name: "greet", kind: greet.kind, range: greet.range, selectionRange: greet.selectionRange },
        { name: "say", kind: say.kind, range: say.range, selectionRange: say.selectionRange },
        { name: "Klass", kind: 5 /* class, not callable */, range: range(0), selectionRange: range(0) },
      ];
      if (rel === "src/changed/util.ts") return symbols(punct);
      return [];
    },
    async prepareCallHierarchy(rel, pos) {
      if (rel === "src/changed/greet.ts" && pos.line === 3) return [greet];
      if (rel === "src/changed/greet.ts" && pos.line === 10) return [say];
      if (rel === "src/changed/util.ts" && pos.line === 5) return [punct];
      return [];
    },
    async incomingCalls(it) {
      if (it.name === "greet") return [{ from: run, fromRanges: [range(2)] }];
      return [];
    },
    async outgoingCalls(it) {
      if (it.name === "greet") return [{ to: punct, fromRanges: [range(4)] }];
      if (it.name === "say") return [{ to: greet, fromRanges: [range(11)] }];
      return [];
    },
  });

  const ids = view.graph.nodes;
  expect(ids).toContain("src/changed/greet.ts:3:0:greet");
  expect(ids).toContain("src/changed/greet.ts:10:0:say");
  expect(ids).toContain("src/changed/util.ts:5:0:punct");
  expect(ids).toContain("src/other/app.ts:1:0:run"); // reached via incomingCalls
  const edges = view.graph.edges.map(e => `${view.nodeMeta[e.from].name}->${view.nodeMeta[e.to].name}`).sort();
  expect(edges).toEqual(["greet->punct", "run->greet", "say->greet"]);
  // Changed-file functions are the seeds; `run` (reached via the hop) is not.
  expect(view.changedFunctions.sort()).toEqual([
    "src/changed/greet.ts:10:0:say",
    "src/changed/greet.ts:3:0:greet",
    "src/changed/util.ts:5:0:punct",
  ]);
});

test("buildCallGraphView reports cycles among the callable functions it walked", async () => {
  const a = item("a.ts", "a", 0);
  const b = item("a.ts", "b", 5);
  const c = item("a.ts", "c", 10);
  const view = await buildCallGraphView({
    rootAbsPath: ROOT,
    changedFiles: ["a.ts"],
    async documentSymbol() {
      return [a, b, c].map(s => ({ name: s.name, kind: s.kind, range: s.range, selectionRange: s.selectionRange }));
    },
    async prepareCallHierarchy(_rel, pos) {
      if (pos.line === 0) return [a];
      if (pos.line === 5) return [b];
      if (pos.line === 10) return [c];
      return [];
    },
    async incomingCalls() { return []; },
    async outgoingCalls(it) {
      if (it.name === "a") return [{ to: b, fromRanges: [] }];
      if (it.name === "b") return [{ to: c, fromRanges: [] }];
      if (it.name === "c") return [{ to: a, fromRanges: [] }]; // closes the cycle
      return [];
    },
  });
  expect(view.cycles).toEqual([[ "a.ts:0:0:a", "a.ts:10:0:c", "a.ts:5:0:b" ]]);
});

test("buildCallGraphView swallows per-symbol errors and keeps going", async () => {
  const a = item("a.ts", "a", 0);
  const view = await buildCallGraphView({
    rootAbsPath: ROOT,
    changedFiles: ["a.ts"],
    async documentSymbol() {
      return [{ name: a.name, kind: a.kind, range: a.range, selectionRange: a.selectionRange }];
    },
    async prepareCallHierarchy() { return [a]; },
    async incomingCalls() { throw new Error("oops"); },
    async outgoingCalls() { return []; },
  });
  expect(view.graph.nodes).toEqual(["a.ts:0:0:a"]);
  expect(view.graph.edges).toEqual([]);
  expect(view.changedFunctions).toEqual(["a.ts:0:0:a"]);
});
