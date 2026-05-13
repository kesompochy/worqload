import { test, expect } from "bun:test";
import {
  parseChangedFilePaths,
  structureLanguageOf,
  isStructureSourcePath,
  buildStructureView,
} from "./structure-view";

test("structureLanguageOf maps source extensions to import-parseable languages", () => {
  expect(structureLanguageOf("web/app.js")).toBe("javascript");
  expect(structureLanguageOf("web/svelte/Foo.svelte")).toBe("javascript");
  expect(structureLanguageOf("src/core.ts")).toBe("typescript");
  expect(structureLanguageOf("src/App.tsx")).toBe("tsx");
  expect(structureLanguageOf("README.md")).toBeNull();
  expect(structureLanguageOf("Makefile")).toBeNull();
  expect(isStructureSourcePath("a.ts")).toBe(true);
  expect(isStructureSourcePath("a.py")).toBe(false);
});

test("parseChangedFilePaths reads paths from git diff headers, including both sides of a rename", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "similarity index 100%",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
  ].join("\n");
  expect(parseChangedFilePaths(diff).sort()).toEqual(["src/a.ts", "src/new-name.ts", "src/old-name.ts"]);
});

test("parseChangedFilePaths returns nothing for an empty diff", () => {
  expect(parseChangedFilePaths("")).toEqual([]);
});

test("buildStructureView scopes the import graph to the changeset's neighborhood", async () => {
  const sources: Record<string, string> = {
    "web/app.js": `import { greet } from "./greet.js";`,
    "web/greet.js": `import { punctuate } from "./util.js";\nimport { far } from "./far.js";`,
    "web/util.js": `export const punctuate = s => s + "!";`,
    "web/far.js": `import "./farther.js";`,
    "web/farther.js": ``,
    "web/unrelated.js": `import "./util.js";`,
    "docs/notes.md": `not source`,
  };
  const view = await buildStructureView({
    allPaths: Object.keys(sources),
    changedPaths: ["web/greet.js", "docs/notes.md"],
    readSource: async p => sources[p] ?? null,
    hops: 1,
  });
  // greet.js (changed) ± 1 hop: app.js (imports it), util.js and far.js (it imports).
  // farther.js is 2 hops; unrelated.js only connects via util.js (also 2 hops). docs/notes.md isn't source.
  expect(view.graph.nodes).toEqual(["web/app.js", "web/far.js", "web/greet.js", "web/util.js"]);
  expect(view.changedFiles).toEqual(["web/greet.js"]);
  expect(view.cycles).toEqual([]);
});

test("buildStructureView flags an import cycle that surfaces in the neighborhood", async () => {
  const sources: Record<string, string> = {
    "a.ts": `import "./b.ts";`,
    "b.ts": `import "./c.ts";`,
    "c.ts": `import "./a.ts";`,
  };
  const view = await buildStructureView({
    allPaths: Object.keys(sources),
    changedPaths: ["b.ts"],
    readSource: async p => sources[p] ?? null,
    hops: 2,
  });
  expect(view.cycles).toEqual([["a.ts", "b.ts", "c.ts"]]);
});

test("buildStructureView skips files that can't be read as text", async () => {
  const view = await buildStructureView({
    allPaths: ["a.ts", "b.ts"],
    changedPaths: ["a.ts"],
    readSource: async p => (p === "a.ts" ? `import "./b.ts";` : null),
    hops: 2,
  });
  expect(view.graph.nodes).toEqual(["a.ts"]);
  expect(view.graph.edges).toEqual([]);
});
