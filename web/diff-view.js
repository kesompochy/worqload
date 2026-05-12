// Diff tab rendering. The server hands us a full-context unified diff; this
// module parses it and renders it GitHub-style, collapsing unchanged stretches
// behind expandable placeholders. Every add/context line carries the same
// data-anchor-* attributes the Files tab uses, so anchored feedback works here.

import { escapeHtml } from "./dom.js";
import { highlightCode, languageForPath } from "./syntax-highlight.js";
import { state, isAnchored, DIFF_CONTEXT_LINES, DIFF_EXPAND_CHUNK, DIFF_MIN_COLLAPSE } from "./state.js";

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

export function renderDiffHtml() {
  if (!state.diff || state.diff.trim() === "") {
    return `<div class="diff-empty">No changes since session start yet.</div>`;
  }
  const files = parseDiffFiles(state.diff);
  const out = [];
  for (const file of files) {
    const collapsed = state.collapsedFiles.has(file.path);
    const escapedPath = escapeHtml(file.path);
    const lang = languageForPath(file.path);
    out.push(`<div class="diff-file${collapsed ? " collapsed" : ""}" data-diff-path="${escapedPath}">`);
    out.push(`<div class="diff-file-header" data-diff-toggle="${escapedPath}"><span class="diff-chevron">▾</span><span>${escapedPath}</span><button type="button" class="copy-path-btn" data-copy-path="${escapedPath}" title="ファイル名をコピー">⧉</button><span class="diff-summary"><span class="add-count">+${file.adds}</span><span class="remove-count">−${file.removes}</span></span></div>`);
    out.push(`<div class="diff-file-body">`);
    const revealed = state.diffExpansions.get(file.path) || [];
    for (const hunk of file.hunks) {
      out.push(`<div class="diff-hunk">${escapeHtml(hunk.header)}</div>`);
      const rows = hunkRows(hunk);
      const visible = visibleRows(rows, revealed);
      for (let i = 0; i < rows.length; ) {
        if (visible[i]) { out.push(renderDiffLineRow(rows[i], file.path, escapedPath, lang)); i++; continue; }
        let j = i;
        while (j < rows.length && !visible[j]) j++;
        out.push(renderDiffExpandRow(rows.slice(i, j), escapedPath, lang));
        i = j;
      }
    }
    out.push(`</div></div>`);
  }
  return out.join("");
}

// One diff line: { kind: "add"|"remove"|"context"|"meta", oldNo, newNo, body }.
// "meta" carries non-line content such as "\ No newline at end of file".
function hunkRows(hunk) {
  const rows = [];
  let oldNo = hunk.oldLine, newNo = hunk.newLine;
  for (const raw of hunk.lines) {
    if (raw.startsWith("+")) { rows.push({ kind: "add", oldNo: null, newNo, body: raw.slice(1) }); newNo++; }
    else if (raw.startsWith("-")) { rows.push({ kind: "remove", oldNo, newNo: null, body: raw.slice(1) }); oldNo++; }
    else if (raw.startsWith(" ")) { rows.push({ kind: "context", oldNo, newNo, body: raw.slice(1) }); oldNo++; newNo++; }
    else rows.push({ kind: "meta", oldNo: null, newNo: null, body: raw });
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

function renderDiffLineRow(row, path, escapedPath, lang) {
  if (row.kind === "meta") {
    return `<div class="diff-line meta"><span class="ln"></span><span class="ln"></span><span class="body">${escapeHtml(row.body)}</span></div>`;
  }
  const oldCol = row.kind === "remove" ? row.oldNo : "";
  const newCol = row.kind === "remove" ? "" : row.newNo;
  const anchorable = row.kind === "add" || row.kind === "context";
  const sel = anchorable && isAnchored(path, row.newNo) ? "selected" : "";
  const dataAttrs = anchorable ? `data-anchor-line="${row.newNo}" data-anchor-path="${escapedPath}"` : "";
  return `<div class="diff-line ${row.kind} ${sel}" ${dataAttrs}><span class="ln">${oldCol}</span><span class="ln">${newCol}</span><span class="body">${highlightCode(row.body, lang)}</span></div>`;
}

function renderDiffExpandRow(hiddenRows, escapedPath, lang) {
  let from = null, to = null;
  for (const row of hiddenRows) {
    if (row.newNo == null) continue;
    if (from == null) from = row.newNo;
    to = row.newNo;
  }
  if (from == null) return hiddenRows.map(r => renderDiffLineRow(r, "", escapedPath, lang)).join("");
  const count = to - from + 1;
  const data = `data-expand-path="${escapedPath}" data-expand-from="${from}" data-expand-to="${to}"`;
  const chunked = count > DIFF_EXPAND_CHUNK;
  const down = chunked ? `<button type="button" class="diff-expand-btn" ${data} data-expand-dir="down" title="Expand ${DIFF_EXPAND_CHUNK} lines from above">↓</button>` : "";
  const up = chunked ? `<button type="button" class="diff-expand-btn" ${data} data-expand-dir="up" title="Expand ${DIFF_EXPAND_CHUNK} lines from below">↑</button>` : "";
  const label = `<span class="diff-expand-label">${count} unchanged line${count === 1 ? "" : "s"}${chunked ? " — click to expand all" : " — click to expand"}</span>`;
  // The whole row falls back to data-expand-dir="all"; the ↑/↓ buttons override it.
  return `<div class="diff-line diff-expand-row" ${data} data-expand-dir="all" role="button"><span class="ln">⋯</span><span class="ln"></span><span class="body">${down}${label}${up}</span></div>`;
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
