import { test, expect } from "bun:test";
import {
  parseImports,
  parseImportSpecifiers,
  resolveImportTarget,
  resolveGoImportTargets,
  buildImportGraph,
  findImportCycles,
  importGraphNeighborhood,
  isImportParseableLanguage,
} from "./import-graph";

test("isImportParseableLanguage covers the JS/TS family and Go", () => {
  expect(isImportParseableLanguage("typescript")).toBe(true);
  expect(isImportParseableLanguage("tsx")).toBe(true);
  expect(isImportParseableLanguage("javascript")).toBe(true);
  expect(isImportParseableLanguage("go")).toBe(true);
  expect(isImportParseableLanguage("python")).toBe(false);
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

test("parseImports / parseImportSpecifiers cover Go single and block imports", () => {
  const src = [
    `package main`,
    ``,
    `import "fmt"`,
    `import _ "github.com/lib/init"`,
    `import alias "github.com/lib/aliased"`,
    ``,
    `import (`,
    `\t"github.com/user/repo/pkg/a"`,
    `\t"github.com/user/repo/pkg/b"`,
    `\t_ "github.com/user/repo/pkg/effect"`,
    `)`,
  ].join("\n");
  const specs = parseImportSpecifiers(src, "go").sort();
  expect(specs).toEqual([
    "fmt",
    "github.com/lib/aliased",
    "github.com/lib/init",
    "github.com/user/repo/pkg/a",
    "github.com/user/repo/pkg/b",
    "github.com/user/repo/pkg/effect",
  ]);
  // Go imports don't carry per-symbol names — references are package-qualified.
  expect(parseImports(src, "go").every(i => i.names.length === 0)).toBe(true);
});

test("parseImports reports the names pulled from each module", () => {
  const cases: Array<[string, { specifier: string; names: string[] }[]]> = [
    [`import { a, b as c } from "./m";`, [{ specifier: "./m", names: ["a", "b"] }]],
    [`import def from "./m";`, [{ specifier: "./m", names: ["default"] }]],
    [`import def, { a } from "./m";`, [{ specifier: "./m", names: ["a", "default"] }]],
    [`import * as ns from "./m";`, [{ specifier: "./m", names: ["*"] }]],
    [`import type { T } from "./m";`, [{ specifier: "./m", names: ["T"] }]],
    [`import "./side-effect";`, [{ specifier: "./side-effect", names: [] }]],
    [`export { a, b } from "./m";`, [{ specifier: "./m", names: ["a", "b"] }]],
    [`export * from "./m";`, [{ specifier: "./m", names: ["*"] }]],
    [`const m = require("./legacy");`, [{ specifier: "./legacy", names: ["*"] }]],
    [`const m = await import("./lazy");`, [{ specifier: "./lazy", names: ["*"] }]],
    [`import {\n  one,\n  two,\n} from "./multi";`, [{ specifier: "./multi", names: ["one", "two"] }]],
  ];
  for (const [src, expected] of cases) {
    expect(parseImports(src, "typescript")).toEqual(expected);
  }
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
    { from: "web/app.js", to: "web/greet.js", symbols: ["greet"] },
    { from: "web/greet.js", to: "web/util/punctuate.js", symbols: ["punctuate"] },
  ]);
});

test("buildImportGraph deduplicates repeated edges and skips self-imports", () => {
  const files = new Map<string, string>([
    ["a.js", `import "./b.js";\nimport { x } from "./b.js";\nconst y = require("./a.js");`],
    ["b.js", ``],
  ]);
  const graph = buildImportGraph(files, () => "javascript");
  expect(graph.edges).toEqual([{ from: "a.js", to: "b.js", symbols: ["x"] }]);
});

test("buildImportGraph wires Go imports under the worktree's module path", () => {
  const files = new Map<string, string>([
    ["cmd/app/main.go", `package main\nimport (\n\t"github.com/me/repo/pkg/util"\n\t"fmt"\n)`],
    ["pkg/util/util.go", `package util`],
    ["pkg/util/extra.go", `package util`],
    ["pkg/other/o.go", `package other`],
  ]);
  const graph = buildImportGraph(files, () => "go", { goModule: "github.com/me/repo" });
  // The `pkg/util` import fans out to every .go file directly in that package
  // (both `util.go` and `extra.go`); standard-library `fmt` is external and
  // `pkg/other/o.go` is untouched.
  expect(graph.edges.map(e => `${e.from}->${e.to}`).sort()).toEqual([
    "cmd/app/main.go->pkg/util/extra.go",
    "cmd/app/main.go->pkg/util/util.go",
  ]);
});

test("buildImportGraph leaves Go imports unresolved when no `goModule` is supplied", () => {
  const files = new Map<string, string>([
    ["main.go", `import "github.com/me/repo/pkg/x"`],
    ["pkg/x/x.go", ``],
  ]);
  expect(buildImportGraph(files, () => "go").edges).toEqual([]);
});

test("resolveGoImportTargets only includes .go files directly inside the target package", () => {
  const known = new Set([
    "pkg/foo/a.go",
    "pkg/foo/b.go",
    "pkg/foo/sub/c.go",  // a different package — different dir
    "pkg/foo/README.md", // not a .go file
  ]);
  expect(resolveGoImportTargets("m.io/r/pkg/foo", "m.io/r", known).sort()).toEqual(["pkg/foo/a.go", "pkg/foo/b.go"]);
  expect(resolveGoImportTargets("fmt", "m.io/r", known)).toEqual([]);            // external
  expect(resolveGoImportTargets("m.io/r/pkg/foo", null, known)).toEqual([]);    // no module path
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
