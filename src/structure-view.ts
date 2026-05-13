// Server side of the Structure viewer: turn a session worktree plus its diff
// into the import-dependency picture the browser draws — a file→file graph
// scoped to the changeset's neighborhood, with import cycles flagged. The pure
// graph machinery lives in import-graph.ts; this module adds the worktree-facing
// glue (which files to read, parsing the diff for changed paths, the language
// each extension maps to) behind injected I/O so it stays unit-testable.

import {
  buildImportGraph,
  findImportCycles,
  importGraphNeighborhood,
  type ImportGraph,
  type SourceLanguage,
} from "./import-graph";

// Extensions whose files participate in the import graph. Limited to the JS/TS
// family (the scope import-graph.ts can parse) plus `.svelte`, whose <script>
// blocks use the same import syntax. Everything else in the worktree is left out
// — it would only add isolated nodes.
const EXTENSION_LANGUAGE: Record<string, SourceLanguage> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", svelte: "javascript",
  jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
};

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function structureLanguageOf(path: string): SourceLanguage {
  return EXTENSION_LANGUAGE[extensionOf(path)] ?? null;
}

export function isStructureSourcePath(path: string): boolean {
  return structureLanguageOf(path) !== null;
}

// The worktree-relative paths a `git diff` touched, taken from its `diff --git
// a/… b/…` headers. Renames list both sides; deletions name a file that no
// longer exists (it simply won't be a graph node, which is fine). Binary-file
// and mode-only entries still carry the header, so they show up here too — a
// harmless over-inclusion since non-source paths aren't graph nodes either.
export function parseChangedFilePaths(diffText: string): string[] {
  const paths = new Set<string>();
  const header = /^diff --git a\/(.+?) b\/(.+)$/;
  for (const line of diffText.split("\n")) {
    const match = header.exec(line);
    if (match) {
      paths.add(match[1]);
      paths.add(match[2]);
    }
  }
  return [...paths];
}

export interface StructureView {
  // The displayed subgraph: changeset files and their import neighborhood.
  graph: ImportGraph;
  // Strongly-connected components within the displayed subgraph (import cycles).
  cycles: string[][];
  // Changed files that ended up in the graph (i.e. are source files that exist),
  // so the UI can highlight them. A subset of the diff's changed paths.
  changedFiles: string[];
}

export const DEFAULT_NEIGHBORHOOD_HOPS = 2;

// Assemble the view. `readSource(path)` returns the file text, or null if it
// can't be read as text (binary / too large / gone) — such files are skipped.
// `allPaths` is the worktree's full file list; only source files are read.
export async function buildStructureView(args: {
  allPaths: string[];
  changedPaths: string[];
  readSource(path: string): Promise<string | null>;
  hops?: number;
}): Promise<StructureView> {
  const sourcePaths = args.allPaths.filter(isStructureSourcePath);
  const filesByPath = new Map<string, string>();
  for (const path of sourcePaths) {
    const text = await args.readSource(path);
    if (text !== null) filesByPath.set(path, text);
  }
  const fullGraph = buildImportGraph(filesByPath, structureLanguageOf);

  const roots = args.changedPaths.filter(p => filesByPath.has(p));
  const hops = args.hops ?? DEFAULT_NEIGHBORHOOD_HOPS;
  const graph = importGraphNeighborhood(fullGraph, roots, hops);
  return { graph, cycles: findImportCycles(graph), changedFiles: roots.sort() };
}
