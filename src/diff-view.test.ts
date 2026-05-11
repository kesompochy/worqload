import { test, expect } from "bun:test";
import { parseDiffFiles, mergeLineRanges, renderDiffHtml } from "../web/diff-view.js";
import { state } from "../web/state.js";

test("parseDiffFiles splits a unified diff into files, hunks and counts", () => {
  const diff = [
    "diff --git a/foo.txt b/foo.txt",
    "index 0000001..0000002 100644",
    "--- a/foo.txt",
    "+++ b/foo.txt",
    "@@ -1,3 +1,3 @@",
    " a",
    "-b",
    "+B",
    " c",
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "index 0000000..0000003",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+hello",
    "+world",
  ].join("\n");
  const files = parseDiffFiles(diff);
  expect(files).toHaveLength(2);

  expect(files[0].path).toBe("foo.txt");
  expect(files[0].adds).toBe(1);
  expect(files[0].removes).toBe(1);
  expect(files[0].hunks).toHaveLength(1);
  expect(files[0].hunks[0].oldLine).toBe(1);
  expect(files[0].hunks[0].newLine).toBe(1);
  expect(files[0].hunks[0].lines).toEqual([" a", "-b", "+B", " c"]);

  expect(files[1].path).toBe("new.txt");
  expect(files[1].adds).toBe(2);
  expect(files[1].removes).toBe(0);
  expect(files[1].hunks[0].lines).toEqual(["+hello", "+world"]);
});

test("parseDiffFiles returns no files for an empty diff", () => {
  expect(parseDiffFiles("")).toEqual([]);
});

test("mergeLineRanges merges overlapping and adjacent ranges", () => {
  expect(mergeLineRanges([])).toEqual([]);
  expect(mergeLineRanges([[3, 5]])).toEqual([[3, 5]]);
  // overlap
  expect(mergeLineRanges([[1, 3], [2, 5]])).toEqual([[1, 5]]);
  // adjacent (gap of exactly 1 is closed)
  expect(mergeLineRanges([[5, 7], [8, 9]])).toEqual([[5, 9]]);
  // disjoint stays separate, and input order doesn't matter
  expect(mergeLineRanges([[10, 12], [1, 3]])).toEqual([[1, 3], [10, 12]]);
  expect(mergeLineRanges([[1, 4], [6, 8], [3, 7]])).toEqual([[1, 8]]);
});

test("mergeLineRanges does not mutate its input", () => {
  const input = [[1, 3], [2, 5]];
  mergeLineRanges(input);
  expect(input).toEqual([[1, 3], [2, 5]]);
});

test("renderDiffHtml puts a copy-path control in each file header", () => {
  state.diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 0000001..0000002 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
  ].join("\n");
  state.collapsedFiles = new Set();
  state.diffExpansions = new Map();
  const html = renderDiffHtml();
  expect(html).toContain(`data-copy-path="src/foo.ts"`);
});
