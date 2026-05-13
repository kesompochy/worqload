import { test, expect } from "bun:test";
import {
  parseImportSpecifiers,
  resolveImportTarget,
  buildImportGraph,
  findImportCycles,
  importGraphNeighborhood,
  isImportParseableLanguage,
} from "./import-graph";

test("isImportParseableLanguage covers the JS/TS family only", () => {
  expect(isImportParseableLanguage("typescript")).toBe(true);
  expect(isImportParseableLanguage("tsx")).toBe(true);
  expect(isImportParseableLanguage("javascript")).toBe(true);
  expect(isImportParseableLanguage("go")).toBe(false);
  expect(isImportParseableLanguage(null)).toBe(false);
});

test("parseImportSpecifiers extracts every import-like specifier", () => {
  const src = [
    `import { a } from "./a.js";`,
    `import b from '../b';`,
    `export { c } from "./c";`,
    `export * from "./d";`,
    `import "./side-effect.css";`,
    `const m = await import("./lazy.js");`,
    `const r = require("../legacy");`,
    `import x from "react";`,
  ].join("\n");
  expect(parseImportSpecifiers(src, "typescript").sort()).toEqual(
    ["../b", "../legacy", "./a.js", "./c", "./d", "./lazy.js", "./side-effect.css", "react"].sort(),
  );
});

test("parseImportSpecifiers returns nothing for non-JS languages", () => {
  expect(parseImportSpecifiers(`import "fmt"`, "go")).toEqual([]);
});

test("resolveImportTarget resolves relative specifiers against the importing file's directory", () => {
  const files = new Set(["web/app.js", "web/lib/util.js", "web/lib/index.js", "src/core.ts"]);
  expect(resolveImportTarget("web/app.js", "./lib/util.js", files)).toBe("web/lib/util.js");
  expect(resolveImportTarget("web/app.js", "./lib/util", files)).toBe("web/lib/util.js");
  expect(resolveImportTarget("web/app.js", "./lib", files)).toBe("web/lib/index.js");
  expect(resolveImportTarget("web/lib/util.js", "../app.js", files)).toBe("web/app.js");
  expect(resolveImportTarget("web/app.js", "../src/core", files)).toBe("src/core.ts");
});

test("resolveImportTarget infers a .ts source from a .js specifier", () => {
  const files = new Set(["src/a.ts", "src/b.ts"]);
  expect(resolveImportTarget("src/a.ts", "./b.js", files)).toBe("src/b.ts");
});

test("resolveImportTarget rejects bare, absolute, and out-of-tree specifiers", () => {
  const files = new Set(["web/app.js"]);
  expect(resolveImportTarget("web/app.js", "react", files)).toBeNull();
  expect(resolveImportTarget("web/app.js", "/etc/passwd", files)).toBeNull();
  expect(resolveImportTarget("web/app.js", "../../outside", files)).toBeNull();
  expect(resolveImportTarget("web/app.js", "./missing", files)).toBeNull();
});

test("buildImportGraph wires resolvable relative imports and ignores external ones", () => {
  const files = new Map<string, string>([
    ["web/app.js", `import { greet } from "./greet.js";\nimport React from "react";`],
    ["web/greet.js", `import { punctuate } from "./util/punctuate.js";`],
    ["web/util/punctuate.js", `export const punctuate = s => s + "!";`],
  ]);
  const graph = buildImportGraph(files, () => "javascript");
  expect(graph.nodes).toEqual(["web/app.js", "web/greet.js", "web/util/punctuate.js"]);
  expect(graph.edges.sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`))).toEqual([
    { from: "web/app.js", to: "web/greet.js" },
    { from: "web/greet.js", to: "web/util/punctuate.js" },
  ]);
});

test("buildImportGraph deduplicates repeated edges and skips self-imports", () => {
  const files = new Map<string, string>([
    ["a.js", `import "./b.js";\nimport { x } from "./b.js";\nconst y = require("./a.js");`],
    ["b.js", ``],
  ]);
  const graph = buildImportGraph(files, () => "javascript");
  expect(graph.edges).toEqual([{ from: "a.js", to: "b.js" }]);
});

test("buildImportGraph treats non-JS files as nodes with no out-edges", () => {
  const files = new Map<string, string>([
    ["main.go", `import "./helper.go"`],
    ["helper.go", ``],
  ]);
  expect(buildImportGraph(files, () => "go").edges).toEqual([]);
});

test("findImportCycles reports strongly-connected components of size >= 2", () => {
  const files = new Map<string, string>([
    ["a.js", `import "./b.js";`],
    ["b.js", `import "./c.js";`],
    ["c.js", `import "./a.js";`],
    ["d.js", `import "./a.js";`],
  ]);
  const graph = buildImportGraph(files, () => "javascript");
  expect(findImportCycles(graph)).toEqual([["a.js", "b.js", "c.js"]]);
});

test("findImportCycles reports a self-importing file", () => {
  // resolveImportTarget drops a literal self-import, so construct the graph directly.
  expect(findImportCycles({ nodes: ["loop.js"], edges: [{ from: "loop.js", to: "loop.js" }] })).toEqual([["loop.js"]]);
});

test("findImportCycles returns nothing for an acyclic graph", () => {
  const files = new Map<string, string>([
    ["a.js", `import "./b.js";\nimport "./c.js";`],
    ["b.js", `import "./c.js";`],
    ["c.js", ``],
  ]);
  expect(findImportCycles(buildImportGraph(files, () => "javascript"))).toEqual([]);
});

test("importGraphNeighborhood keeps nodes within N hops of the roots, both directions", () => {
  // chain: e -> d -> root -> a -> b -> c   (arrows = "imports")
  const graph = {
    nodes: ["root", "a", "b", "c", "d", "e"],
    edges: [
      { from: "d", to: "root" },
      { from: "e", to: "d" },
      { from: "root", to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  };
  const near = importGraphNeighborhood(graph, ["root"], 1);
  expect(near.nodes).toEqual(["a", "d", "root"]);
  expect(near.edges).toEqual([
    { from: "d", to: "root" },
    { from: "root", to: "a" },
  ]);
  expect(importGraphNeighborhood(graph, ["root"], 2).nodes).toEqual(["a", "b", "d", "e", "root"]);
});

test("importGraphNeighborhood ignores roots absent from the graph", () => {
  const graph = { nodes: ["a", "b"], edges: [{ from: "a", to: "b" }] };
  expect(importGraphNeighborhood(graph, ["ghost", "a"], 1).nodes).toEqual(["a", "b"]);
  expect(importGraphNeighborhood(graph, ["ghost"], 5).nodes).toEqual([]);
});
