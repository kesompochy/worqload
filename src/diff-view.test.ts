import { test, expect } from "bun:test";
import { parseDiffFiles, mergeLineRanges, buildDiffModel } from "../web/diff-view.js";

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

test("buildDiffModel reports an empty diff", () => {
  expect(buildDiffModel("", new Set(), new Map())).toEqual({ empty: true, files: [] });
  expect(buildDiffModel("   \n", new Set(), new Map())).toEqual({ empty: true, files: [] });
});

// One change at the top of a long file: the lines around the change stay
// visible, the unchanged tail collapses behind a single expandable gap, and the
// file header carries the path the copy-path control / collapse toggle key on.
const longDiff = [
  "diff --git a/big.txt b/big.txt",
  "index 0000001..0000002 100644",
  "--- a/big.txt",
  "+++ b/big.txt",
  "@@ -1,12 +1,12 @@",
  "-old",
  "+new",
  " l2",
  " l3",
  " l4",
  " l5",
  " l6",
  " l7",
  " l8",
  " l9",
  " l10",
  " l11",
  " l12",
].join("\n");

test("buildDiffModel collapses an unchanged stretch into one gap segment", () => {
  const model = buildDiffModel(longDiff, new Set(), new Map());
  expect(model.empty).toBe(false);
  expect(model.files).toHaveLength(1);
  const file = model.files[0];
  expect(file.path).toBe("big.txt");
  expect(file.collapsed).toBe(false);
  expect(file.adds).toBe(1);
  expect(file.removes).toBe(1);
  expect(file.hunks).toHaveLength(1);

  const segments = file.hunks[0].segments;
  const lines = segments.filter(s => s.type === "line");
  const gaps = segments.filter(s => s.type === "gap");
  // -old, +new, and the 3 context lines kept around the change (DIFF_CONTEXT_LINES).
  expect(lines).toHaveLength(5);
  expect(gaps).toHaveLength(1);
  expect(gaps[0]).toMatchObject({ from: 5, to: 12, count: 8, chunked: false });
  expect(lines[0].row).toMatchObject({ kind: "remove", oldNo: 1, newNo: null, body: "old", anchorable: false });
  expect(lines[1].row).toMatchObject({ kind: "add", oldNo: null, newNo: 1, body: "new", anchorable: true });
  expect(lines[2].row).toMatchObject({ kind: "context", newNo: 2, anchorable: true });
});

test("buildDiffModel marks a file collapsed when its path is in collapsedFiles", () => {
  const model = buildDiffModel(longDiff, new Set(["big.txt"]), new Map());
  expect(model.files[0].collapsed).toBe(true);
});

test("buildDiffModel reveals lines covered by diffExpansions, removing the gap", () => {
  const model = buildDiffModel(longDiff, new Set(), new Map([["big.txt", [[5, 12]]]]));
  const segments = model.files[0].hunks[0].segments;
  expect(segments.every(s => s.type === "line")).toBe(true);
  expect(segments).toHaveLength(13); // -old, +new, l2..l12
});
