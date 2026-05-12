// Files tab: a worktree file explorer. The tree is built client-side from the
// flat path list /sessions/:id/files returns; selecting a leaf fetches that
// file's full text. FilesView.svelte paints the structure this module
// produces; both functions here are pure so they're easy to test.

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

// Walk the directory tree depth-first (dirs before files, each alphabetical —
// the order the explorer shows) into a flat row list the component renders with
// a single {#each}: dirs the user collapsed are emitted but their subtree is
// skipped.
export function flattenFileTree(paths, collapsedDirs) {
  const rows = [];
  const walk = (node, depth) => {
    for (const name of [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
      const dir = node.dirs.get(name);
      const collapsed = collapsedDirs.has(dir.path);
      rows.push({ kind: "dir", name, path: dir.path, depth, collapsed });
      if (!collapsed) walk(dir, depth + 1);
    }
    for (const f of node.files.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({ kind: "file", name: f.name, path: f.path, depth });
    }
  };
  walk(buildFileTree(paths), 0);
  return rows;
}
