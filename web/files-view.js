// Files tab: a worktree file explorer. The tree is built client-side from the
// flat path list /sessions/:id/files returns; selecting a leaf fetches that
// file's full text. Every content line carries the same data-anchor-* attrs
// the diff view uses, so anchored feedback works on whole files too.

import { escapeHtml, formatBytes } from "./dom.js";
import { highlightCode, languageForPath } from "./syntax-highlight.js";
import { state, isAnchored } from "./state.js";

export function renderFilesHtml() {
  const treeHtml = !state.filesLoaded
    ? `<div class="empty"><span class="spinner"></span> loading…</div>`
    : state.files.length === 0
      ? `<div class="empty">No files in this worktree.</div>`
      : `<div class="file-tree-list">${renderFileTreeNode(buildFileTree(state.files), 0)}</div>`;
  return `<div class="file-explorer">
    <div class="file-tree-pane">${treeHtml}</div>
    <div class="file-content-pane">${renderFileContentHtml()}</div>
  </div>`;
}

export function buildFileTree(paths) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = node.dirs.get(seg);
      if (!child) {
        child = { name: seg, path: node.path ? `${node.path}/${seg}` : seg, dirs: new Map(), files: [] };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1], path: p });
  }
  return root;
}

function renderFileTreeNode(node, depth) {
  const indent = n => `padding-left:${(0.3 + n * 0.9).toFixed(2)}rem`;
  const out = [];
  for (const name of [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
    const dir = node.dirs.get(name);
    const collapsed = state.fileTreeCollapsed.has(dir.path);
    out.push(`<div class="file-tree-row is-dir${collapsed ? " collapsed" : ""}" data-dir-toggle="${escapeHtml(dir.path)}" style="${indent(depth)}" title="${escapeHtml(dir.path)}"><span class="twisty">▾</span><span class="name">${escapeHtml(name)}/</span></div>`);
    if (!collapsed) out.push(renderFileTreeNode(dir, depth + 1));
  }
  for (const f of node.files.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const sel = f.path === state.selectedFilePath ? " selected" : "";
    out.push(`<div class="file-tree-row is-file${sel}" data-file-open="${escapeHtml(f.path)}" style="${indent(depth)}" title="${escapeHtml(f.path)}"><span class="twisty">▾</span><span class="name">${escapeHtml(f.name)}</span></div>`);
  }
  return out.join("");
}

function renderFileContentHtml() {
  const fc = state.fileContent;
  if (!fc) return `<div class="placeholder">Select a file from the tree to view it.</div>`;
  const path = fc.path || state.selectedFilePath || "";
  const escapedPath = escapeHtml(path);
  const header = meta => `<div class="file-content-header"><span>${escapedPath}</span><button type="button" class="copy-path-btn" data-copy-path="${escapedPath}" title="ファイル名をコピー">⧉</button>${meta ? `<span class="file-content-meta">${escapeHtml(meta)}</span>` : ""}</div>`;
  if (fc.loading) return `${header("")}<div class="file-msg"><span class="spinner"></span> loading…</div>`;
  if (fc.error) return `${header("")}<div class="file-msg">⚠ ${escapeHtml(fc.error)}</div>`;
  if (fc.binary) return `${header("binary")}<div class="file-msg">Binary file — not shown.</div>`;
  if (fc.tooLarge) return `${header(formatBytes(fc.size))}<div class="file-msg">File too large to display (${escapeHtml(formatBytes(fc.size))}).</div>`;
  const content = fc.content ?? "";
  const lang = languageForPath(path);
  const lines = content.split("\n");
  // A trailing newline yields a final empty element; drop it so there's no phantom last line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const rows = lines.map((line, i) => {
    const n = i + 1;
    const sel = isAnchored(path, n) ? " selected" : "";
    return `<div class="file-line${sel}" data-anchor-line="${n}" data-anchor-path="${escapedPath}"><span class="ln">${n}</span><span class="body">${highlightCode(line, lang)}</span></div>`;
  }).join("");
  return `${header(`${lines.length} line${lines.length === 1 ? "" : "s"}`)}<div class="file-content-body">${rows}</div>`;
}
