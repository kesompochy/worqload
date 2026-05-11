import { test, expect } from "bun:test";
import { buildFileTree } from "../web/files-view.js";

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
