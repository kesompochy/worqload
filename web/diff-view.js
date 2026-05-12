// Diff tab model. The server hands us a full-context unified diff; this module
// parses it and builds the structure the Diff tab renders GitHub-style,
// collapsing unchanged stretches behind expandable placeholders. Each
// add/context line carries its new-file line number so anchored feedback works
// here the same way it does on the Files tab. The rendering itself lives in
// web/svelte/DiffView.svelte.

import { languageForPath } from "./syntax-highlight.js";
import { DIFF_CONTEXT_LINES, DIFF_EXPAND_CHUNK, DIFF_MIN_COLLAPSE } from "./state.svelte.js";

export function parseDiffFiles(text) {
  const files = [];
  let currentFile = null;
  let currentHunk = null;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/^diff --git a\/.+? b\/(.+)$/);
      currentFile = { path: m ? m[1] : "?", hunks: [], adds: 0, removes: 0 };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }
    if (raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") ||
        raw.startsWith("new file mode ") || raw.startsWith("deleted file mode ") ||
        raw.startsWith("rename ") || raw.startsWith("similarity ") || raw.startsWith("dissimilarity ") ||
        raw.startsWith("Binary files ")) {
      continue;
    }
    if (!currentFile) continue;
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      currentHunk = {
        header: raw,
        oldLine: m ? Number(m[1]) : 0,
        newLine: m ? Number(m[2]) : 0,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue;
    currentHunk.lines.push(raw);
    if (raw.startsWith("+")) currentFile.adds++;
    else if (raw.startsWith("-")) currentFile.removes++;
  }
  return files;
}

// Build the Diff tab's render model from the raw unified diff plus the user's
// per-file collapse / expand state. Pure — DiffView.svelte derives off this.
// Shape: { empty: true } | { empty: false, files: [{ path, adds, removes,
// collapsed, lang, hunks: [{ header, segments: [...] }] }] }, where a segment
// is either { type: "line", row: { kind, oldNo, newNo, body, anchorable } } or
// { type: "gap", from, to, count, chunked } (a run of hidden unchanged lines
// the user can click to expand; `chunked` runs offer ↑/↓ partial expansion).
export function buildDiffModel(diffText, collapsedFiles, diffExpansions) {
  if (!diffText || diffText.trim() === "") return { empty: true, files: [] };
  const files = parseDiffFiles(diffText).map(file => {
    const revealed = diffExpansions.get(file.path) || [];
    return {
      path: file.path,
      adds: file.adds,
      removes: file.removes,
      collapsed: collapsedFiles.has(file.path),
      lang: languageForPath(file.path),
      hunks: file.hunks.map(hunk => ({ header: hunk.header, segments: hunkSegments(hunkRows(hunk), revealed) })),
    };
  });
  return { empty: false, files };
}

// One diff line: { kind: "add"|"remove"|"context"|"meta", oldNo, newNo, body,
// anchorable }. "meta" carries non-line content such as
// "\ No newline at end of file". `anchorable` marks the add/context lines the
// diff lets you anchor feedback to (by their new-file line number).
function hunkRows(hunk) {
  const rows = [];
  let oldNo = hunk.oldLine, newNo = hunk.newLine;
  for (const raw of hunk.lines) {
    if (raw.startsWith("+")) { rows.push({ kind: "add", oldNo: null, newNo, body: raw.slice(1), anchorable: true }); newNo++; }
    else if (raw.startsWith("-")) { rows.push({ kind: "remove", oldNo, newNo: null, body: raw.slice(1), anchorable: false }); oldNo++; }
    else if (raw.startsWith(" ")) { rows.push({ kind: "context", oldNo, newNo, body: raw.slice(1), anchorable: true }); oldNo++; newNo++; }
    else rows.push({ kind: "meta", oldNo: null, newNo: null, body: raw, anchorable: false });
  }
  return rows;
}

function visibleRows(rows, revealed) {
  const n = rows.length;
  const visible = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    if (row.kind === "add" || row.kind === "remove") {
      for (let j = Math.max(0, i - DIFF_CONTEXT_LINES); j <= Math.min(n - 1, i + DIFF_CONTEXT_LINES); j++) visible[j] = true;
    } else if (row.kind === "context" && lineInRanges(row.newNo, revealed)) {
      visible[i] = true;
    }
  }
  // A placeholder taking up as much room as the lines it hides is pointless.
  for (let i = 0; i < n; ) {
    if (visible[i]) { i++; continue; }
    let j = i;
    while (j < n && !visible[j]) j++;
    if (j - i < DIFF_MIN_COLLAPSE) for (let k = i; k < j; k++) visible[k] = true;
    i = j;
  }
  // "\ No newline" markers belong with the line above them.
  for (let i = 0; i < n; i++) if (rows[i].kind === "meta") visible[i] = i > 0 ? visible[i - 1] : true;
  return visible;
}

// Turn a hunk's rows into the segments DiffView paints: visible rows pass
// through one at a time; each maximal run of hidden rows becomes one "gap"
// placeholder spanning its new-file line range. A hidden run with no
// new-file-numbered line in it (a collapsed pure-deletion block) can't be
// expanded, so those rows are shown instead.
function hunkSegments(rows, revealed) {
  const visible = visibleRows(rows, revealed);
  const segments = [];
  for (let i = 0; i < rows.length; ) {
    if (visible[i]) { segments.push({ type: "line", row: rows[i] }); i++; continue; }
    let j = i;
    while (j < rows.length && !visible[j]) j++;
    const hidden = rows.slice(i, j);
    let from = null, to = null;
    for (const row of hidden) { if (row.newNo == null) continue; if (from == null) from = row.newNo; to = row.newNo; }
    if (from == null) for (const row of hidden) segments.push({ type: "line", row });
    else segments.push({ type: "gap", from, to, count: to - from + 1, chunked: to - from + 1 > DIFF_EXPAND_CHUNK });
    i = j;
  }
  return segments;
}

export function mergeLineRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const [start, end] = sorted[i];
    if (start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function lineInRanges(lineNo, ranges) {
  if (lineNo == null) return false;
  for (const [start, end] of ranges) if (lineNo >= start && lineNo <= end) return true;
  return false;
}
