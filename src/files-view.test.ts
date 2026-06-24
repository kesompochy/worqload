import { test, expect } from "bun:test";
import { buildFileTree, flattenFileTree, collectDirectoryPaths } from "../web/files-view.js";

test("buildFileTree groups flat paths into a directory tree", () => {
  const root = buildFileTree(["src/a.js", "src/b/c.js", "README.md"]);
  expect(root.path).toBe("");
  expect(root.files.map((f) => f.path)).toEqual(["README.md"]);
  expect([...root.dirs.keys()]).toEqual(["src"]);

  const src = root.dirs.get("src");
  expect(src.path).toBe("src");
  expect(src.files).toEqual([{ name: "a.js", path: "src/a.js" }]);
  expect([...src.dirs.keys()]).toEqual(["b"]);

  const b = src.dirs.get("b");
  expect(b.path).toBe("src/b");
  expect(b.files).toEqual([{ name: "c.js", path: "src/b/c.js" }]);
  expect(b.dirs.size).toBe(0);
});

test("buildFileTree returns an empty root for no paths", () => {
  const root = buildFileTree([]);
  expect(root.files).toEqual([]);
  expect(root.dirs.size).toBe(0);
});

test("flattenFileTree walks dirs before files, depth-first, alphabetical", () => {
  const rows = flattenFileTree(["src/a.js", "src/b/c.js", "README.md"], new Set());
  expect(rows).toEqual([
    { kind: "dir", name: "src", path: "src", depth: 0, collapsed: false },
    { kind: "dir", name: "b", path: "src/b", depth: 1, collapsed: false },
    { kind: "file", name: "c.js", path: "src/b/c.js", depth: 2 },
    { kind: "file", name: "a.js", path: "src/a.js", depth: 1 },
    { kind: "file", name: "README.md", path: "README.md", depth: 0 },
  ]);
});

test("flattenFileTree omits the subtree of a collapsed directory", () => {
  const rows = flattenFileTree(["src/a.js", "src/b/c.js", "README.md"], new Set(["src"]));
  expect(rows).toEqual([
    { kind: "dir", name: "src", path: "src", depth: 0, collapsed: true },
    { kind: "file", name: "README.md", path: "README.md", depth: 0 },
  ]);
});

test("collectDirectoryPaths returns all directory paths from flat file paths", () => {
  const dirs = collectDirectoryPaths(["src/a.js", "src/b/c.js", "README.md"]);
  expect(dirs).toEqual(new Set(["src", "src/b"]));
});

test("collectDirectoryPaths returns an empty set for root-only files", () => {
  const dirs = collectDirectoryPaths(["README.md", "package.json"]);
  expect(dirs).toEqual(new Set());
});

test("collectDirectoryPaths handles deeply nested paths", () => {
  const dirs = collectDirectoryPaths(["a/b/c/d.js"]);
  expect(dirs).toEqual(new Set(["a", "a/b", "a/b/c"]));
});
