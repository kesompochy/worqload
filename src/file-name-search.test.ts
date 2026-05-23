import { test, expect } from "bun:test";
import { matchFilePaths } from "../web/file-name-search.js";

const paths = [
  "README.md",
  "src/web-server.ts",
  "src/worktree.ts",
  "web/api.js",
  "web/svelte/FilesView.svelte",
  "web/svelte/FileSearchModal.svelte",
];

test("empty query returns nothing", () => {
  expect(matchFilePaths(paths, "")).toEqual({ matches: [], truncated: false });
  expect(matchFilePaths(paths, "  ")).toEqual({ matches: [], truncated: false });
});

test("matches as a case-insensitive subsequence over the path", () => {
  const { matches } = matchFilePaths(paths, "websrv");
  expect(matches).toContain("src/web-server.ts");
  expect(matches).not.toContain("README.md");
});

test("ranks basename hits above ones that only match via the directory", () => {
  const { matches } = matchFilePaths(["web/api.js", "src/web-server.ts"], "web");
  // Both contain "web", but only one has it in the basename.
  expect(matches[0]).toBe("src/web-server.ts");
});

test("ranks a contiguous substring above a scattered subsequence", () => {
  const { matches } = matchFilePaths(["web/svelte/FilesView.svelte", "web/svelte/FileSearchModal.svelte"], "filesv");
  expect(matches[0]).toBe("web/svelte/FilesView.svelte");
});

test("non-matching query yields no matches", () => {
  expect(matchFilePaths(paths, "zzzqqq").matches).toEqual([]);
});

test("caps results and flags truncation", () => {
  const many = Array.from({ length: 250 }, (_, i) => `dir/file${i}.ts`);
  const res = matchFilePaths(many, "file");
  expect(res.matches.length).toBe(200);
  expect(res.truncated).toBe(true);
});

test("does not flag truncation when under the cap", () => {
  const res = matchFilePaths(paths, "ts");
  expect(res.truncated).toBe(false);
});
