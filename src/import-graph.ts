// Module dependency graph derived from import statements: which source file
// imports which other source file within a worktree. This is the lightweight,
// language-server-free counterpart to the LSP-backed call graph — it reads the
// `import` / `export ... from` / `require` / dynamic `import()` syntax directly,
// the same regex-on-source spirit as the heuristic code-nav fallback. The
// Structure viewer renders the result to show the shape of a changeset's
// surroundings and to flag import cycles.
//
// Scope: the JavaScript/TypeScript family only. Other languages (notably Go,
// which has package-level rather than file-level imports and ships gopls) get an
// empty import list here; their structure view will come from call-hierarchy.

// Path convention throughout: worktree-relative, POSIX separators (the form
// `git ls-files` produces). The graph never references anything outside the set
// of files it was built from.

export type SourceLanguage = "javascript" | "typescript" | "jsx" | "tsx" | (string & {}) | null | undefined;

const JS_FAMILY = new Set(["javascript", "typescript", "jsx", "tsx"]);

export function isImportParseableLanguage(language: SourceLanguage): boolean {
  if (typeof language !== "string") return false;
  return language === "go" || JS_FAMILY.has(language);
}

// One import-like statement: the module specifier, plus the names pulled from
// that module. `names` is the *source* name of each binding (`import { a as b }`
// → "a"), with "default" for a default import and "*" for a namespace import,
// `require(…)`, or `import(…)` (we can't see which members those touch). A bare
// side-effect import (`import "x"`) yields an empty `names`. Bare specifiers
// ("react") are kept here too — `resolveImportTarget` rejects them as external.
export interface ParsedImport {
  specifier: string;
  names: string[];
}

// Captures the clause between `import`/`export` and `from "specifier"`. The body
// `[^;'"`]*?` spans newlines (so multi-line `{ … }` clauses are caught) but
// stops at a statement terminator or string delimiter. The optional `type` is
// consumed so `import type { X } from …` reports `X`, not `type X`.
const FROM_IMPORT = /\b(?:import|export)\s+(?:type\s+)?([^;'"`]*?)\s+from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /\bimport\s*['"]([^'"]+)['"]/g;
const CALL_IMPORT = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const NAMED_BLOCK = /\{([^{}]*)\}/;

function namesFromImportClause(clause: string): string[] {
  const names: string[] = [];
  const block = NAMED_BLOCK.exec(clause);
  if (block) {
    for (const entry of block[1].split(",")) {
      const sourceName = entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (sourceName) names.push(sourceName);
    }
  }
  // What's left after removing the `{ … }` part: a `*` (with or without `as ns`)
  // is a whole-module import/re-export, and a leading bare identifier is a
  // default import.
  const rest = block ? clause.replace(NAMED_BLOCK, " ") : clause;
  if (/(^|[\s,])\*/.test(rest)) names.push("*");
  const leadingIdentifier = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(rest);
  if (leadingIdentifier && leadingIdentifier[1] !== "type") names.push("default");
  return [...new Set(names)];
}

export function parseImports(sourceText: string, language: SourceLanguage): ParsedImport[] {
  if (typeof sourceText !== "string") return [];
  if (language === "go") return parseGoImports(sourceText);
  if (!isImportParseableLanguage(language)) return [];
  return parseJsImports(sourceText);
}

function parseJsImports(sourceText: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  for (const match of sourceText.matchAll(FROM_IMPORT)) {
    imports.push({ specifier: match[2], names: namesFromImportClause(match[1]) });
  }
  for (const match of sourceText.matchAll(SIDE_EFFECT_IMPORT)) {
    imports.push({ specifier: match[1], names: [] });
  }
  for (const match of sourceText.matchAll(CALL_IMPORT)) {
    imports.push({ specifier: match[1], names: ["*"] });
  }
  return imports;
}

// Go has two import forms: a single `import "spec"` (optionally preceded by an
// alias or `_`), and a block `import ( ... )` listing one specifier per line.
// We don't track import names — Go uses package-qualified references, not the
// "import { x, y }" style — so `names` is left empty.
const GO_IMPORT_BLOCK = /\bimport\s*\(([\s\S]*?)\)/g;
const GO_IMPORT_SPEC = /"([^"]+)"/g;
const GO_IMPORT_SINGLE = /\bimport\s+(?:(?:_|[A-Za-z_]\w*|\.)\s+)?"([^"]+)"/g;
function parseGoImports(sourceText: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  for (const block of sourceText.matchAll(GO_IMPORT_BLOCK)) {
    for (const spec of block[1].matchAll(GO_IMPORT_SPEC)) {
      imports.push({ specifier: spec[1], names: [] });
    }
  }
  for (const match of sourceText.matchAll(GO_IMPORT_SINGLE)) {
    imports.push({ specifier: match[1], names: [] });
  }
  return imports;
}

export function parseImportSpecifiers(sourceText: string, language: SourceLanguage): string[] {
  return [...new Set(parseImports(sourceText, language).map(i => i.specifier))];
}

// ---- specifier resolution ----

// Resolve a POSIX-style relative path expressed *from a file*. `fromFile` is the
// importing file (worktree-relative), so its directory is the base; "." and ".."
// segments are collapsed. Returns null if it would escape the worktree root.
function joinFromFile(fromFile: string, relative: string): string | null {
  const baseSegments = fromFile.split("/").slice(0, -1);
  const segments = [...baseSegments];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join("/");
}

const RESOLUTION_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];

function pickExisting(candidate: string, knownFiles: ReadonlySet<string>): string | null {
  if (knownFiles.has(candidate)) return candidate;
  for (const ext of RESOLUTION_EXTENSIONS) {
    const withExt = `${candidate}.${ext}`;
    if (knownFiles.has(withExt)) return withExt;
  }
  for (const ext of RESOLUTION_EXTENSIONS) {
    const indexFile = `${candidate}/index.${ext}`;
    if (knownFiles.has(indexFile)) return indexFile;
  }
  return null;
}

// Map an import specifier appearing in `fromFile` to the worktree file it refers
// to, or null when it is external (bare specifier), absolute, or unresolvable
// within `knownFiles`. Mirrors Node/TypeScript relative-path resolution closely
// enough for a dependency picture: extension inference and `index.*` directory
// imports; a `.js` specifier that only exists as `.ts` resolves to the `.ts`.
export function resolveImportTarget(
  fromFile: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null; // bare or absolute → external
  const joined = joinFromFile(fromFile, specifier);
  if (joined === null) return null;
  const direct = pickExisting(joined, knownFiles);
  if (direct) return direct;
  // A specifier written with an explicit extension that doesn't exist on disk
  // (e.g. `./foo.js` against a `foo.ts` source) — retry with the extension stripped.
  const lastSlash = joined.lastIndexOf("/");
  const lastDot = joined.lastIndexOf(".");
  if (lastDot > lastSlash) {
    const withoutExt = joined.slice(0, lastDot);
    return pickExisting(withoutExt, knownFiles);
  }
  return null;
}

// Go imports are package-level: `import "github.com/org/repo/pkg/foo"` points at
// a *directory* of .go files, not a single file. We map it to every .go file
// directly inside that directory (no subdirectories — those are different
// packages). Returns `[]` when the import path isn't under the worktree's
// module path, when no go.mod was found (`modulePath` is null), or when the
// target directory has no .go files in `knownFiles`.
export function resolveGoImportTargets(
  specifier: string,
  modulePath: string | null,
  knownFiles: ReadonlySet<string>,
): string[] {
  if (!modulePath) return [];
  if (specifier !== modulePath && !specifier.startsWith(modulePath + "/")) return [];
  const dir = specifier === modulePath ? "" : specifier.slice(modulePath.length + 1);
  const prefix = dir === "" ? "" : dir + "/";
  const results: string[] = [];
  for (const file of knownFiles) {
    if (!file.endsWith(".go")) continue;
    if (prefix && !file.startsWith(prefix)) continue;
    if (file.slice(prefix.length).includes("/")) continue; // subdir = different package
    results.push(file);
  }
  return results.sort();
}

// ---- graph ----

export interface ImportEdge {
  from: string;
  to: string;
  // The names `from` pulls from `to` (deduped, sorted). "default" / "*" stand
  // for a default / whole-module import; empty only when the sole import is a
  // bare side-effect `import "…"`. This is what answers "which symbols depend".
  symbols: string[];
}

export interface ImportGraph {
  nodes: string[]; // worktree-relative paths, sorted
  edges: ImportEdge[]; // deduplicated (one per from->to pair); never self-referential
}

// Optional knobs for `buildImportGraph`. `goModule` is the `module` line from
// the worktree's go.mod (e.g. `github.com/user/repo`); without it Go imports
// can't be resolved to worktree files.
export interface BuildImportGraphOptions {
  goModule?: string | null;
}

// Build the dependency graph over `filesByPath` (worktree-relative path →
// source text). `languageOf` decides how each file is parsed for imports; files
// whose language isn't supported contribute a node but no out-edges. Edges to
// files outside `filesByPath` are dropped, so the graph is closed.
export function buildImportGraph(
  filesByPath: ReadonlyMap<string, string>,
  languageOf: (path: string) => SourceLanguage,
  options: BuildImportGraphOptions = {},
): ImportGraph {
  const nodes = [...filesByPath.keys()].sort();
  const knownFiles = new Set(nodes);
  const symbolsByEdge = new Map<string, Set<string>>();
  const edgeOrder: { from: string; to: string }[] = [];
  for (const from of nodes) {
    const language = languageOf(from);
    for (const parsed of parseImports(filesByPath.get(from) ?? "", language)) {
      const targets = language === "go"
        ? resolveGoImportTargets(parsed.specifier, options.goModule ?? null, knownFiles)
        : (() => { const t = resolveImportTarget(from, parsed.specifier, knownFiles); return t ? [t] : []; })();
      for (const to of targets) {
        if (to === from) continue;
        const key = `${from} ${to}`;
        let symbols = symbolsByEdge.get(key);
        if (!symbols) {
          symbols = new Set<string>();
          symbolsByEdge.set(key, symbols);
          edgeOrder.push({ from, to });
        }
        for (const name of parsed.names) symbols.add(name);
      }
    }
  }
  const edges: ImportEdge[] = edgeOrder.map(({ from, to }) => ({
    from,
    to,
    symbols: [...(symbolsByEdge.get(`${from} ${to}`) ?? [])].sort(),
  }));
  return { nodes, edges };
}

// ---- cycle detection (Tarjan strongly-connected components) ----

// The strongly-connected components of size ≥ 2, plus any self-loop node, each
// returned as a sorted list of paths. A non-empty result means the import graph
// has a cycle — usually a code smell worth surfacing in review.
export function findImportCycles(graph: ImportGraph): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) adjacency.set(node, []);
  const selfLoopNodes = new Set<string>();
  for (const { from, to } of graph.edges) {
    if (from === to) selfLoopNodes.add(from);
    else adjacency.get(from)?.push(to);
  }

  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const components: string[][] = [];

  // Iterative Tarjan so deep import chains don't blow the call stack.
  const callStack: { node: string; childIndex: number }[] = [];
  for (const start of graph.nodes) {
    if (index.has(start)) continue;
    callStack.push({ node: start, childIndex: 0 });
    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const { node } = frame;
      if (frame.childIndex === 0) {
        index.set(node, counter);
        lowLink.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
      }
      const neighbors = adjacency.get(node) ?? [];
      if (frame.childIndex < neighbors.length) {
        const next = neighbors[frame.childIndex++];
        if (!index.has(next)) {
          callStack.push({ node: next, childIndex: 0 });
        } else if (onStack.has(next)) {
          lowLink.set(node, Math.min(lowLink.get(node)!, index.get(next)!));
        }
        continue;
      }
      // All neighbors processed: settle this node's low-link into its parent and
      // pop a component if `node` is a root.
      callStack.pop();
      const parent = callStack[callStack.length - 1];
      if (parent) lowLink.set(parent.node, Math.min(lowLink.get(parent.node)!, lowLink.get(node)!));
      if (lowLink.get(node) === index.get(node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
          if (popped === node) break;
        }
        if (component.length >= 2) components.push(component.sort());
      }
    }
  }
  for (const node of selfLoopNodes) components.push([node]);
  return components;
}

// ---- neighborhood extraction ----

// The subgraph reachable from `roots` within `hops` edge traversals in *either*
// direction (a file's importers and its imports both count). This is how the
// Structure view scopes the picture to a changeset: the changed files are the
// roots, and a couple of hops out shows what they touch and what touches them.
// `roots` not present in the graph are ignored.
export function importGraphNeighborhood(graph: ImportGraph, roots: Iterable<string>, hops: number): ImportGraph {
  const nodeSet = new Set(graph.nodes);
  const undirectedNeighbors = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const list = undirectedNeighbors.get(a);
    if (list) list.push(b);
    else undirectedNeighbors.set(a, [b]);
  };
  for (const { from, to } of graph.edges) {
    link(from, to);
    link(to, from);
  }
  const included = new Set<string>();
  let frontier: string[] = [];
  for (const root of roots) {
    if (nodeSet.has(root) && !included.has(root)) {
      included.add(root);
      frontier.push(root);
    }
  }
  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      for (const neighbor of undirectedNeighbors.get(node) ?? []) {
        if (!included.has(neighbor)) {
          included.add(neighbor);
          nextFrontier.push(neighbor);
        }
      }
    }
    frontier = nextFrontier;
  }
  return {
    nodes: [...included].sort(),
    edges: graph.edges.filter(e => included.has(e.from) && included.has(e.to)),
  };
}
