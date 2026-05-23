// Code navigation for the Files viewer: from a clicked symbol token, resolve
// where it is defined and where it is used. Resolution goes through an ordered
// list of *providers*; the first one that answers wins:
//
//   1. the server provider — asks GET /sessions/:id/code-nav/{definition,references},
//      which is backed by a real language server (LSP) when one is registered
//      for the file's language server-side (see src/language-servers.ts). It
//      returns `null` ("not available — try the next provider") when there is no
//      such server, e.g. for languages no extension covers, or when worqload
//      runs without its node_modules.
//   2. the heuristic provider — a deliberately lightweight, per-line fallback:
//      regex-based declaration finding plus the existing full-text search,
//      narrowed to whole-word matches. Always available; imprecise (it can hit
//      strings/comments and same-named symbols), but it means navigation never
//      simply stops working.
//
// Extension points:
//   - `registerCodeNavProvider(provider)` — add a provider (e.g. a client-side
//     analyzer). `provider.provideDefinitions(ctx)` / `provider.provideReferences(ctx)`
//     return `Promise<Location[] | null>` (null = pass to the next provider);
//     either method may be omitted. `ctx = { sessionId, path, language,
//     sourceText, line, column, symbol }` (line 1-based, column 0-based).
//     `Location = { path, line, column?, text? }` (line 1-based, path
//     worktree-relative).
//   - `registerDeclarationFinder(languages, finder)` / `registerReferenceRefiner(...)`
//     — extend the heuristic fallback for a language without touching providers.

import { fetchCodeNavLocations, searchFiles } from "./api.js";

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

export function isIdentifierName(value) {
  return typeof value === "string" && IDENTIFIER_RE.test(value);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- provider registry & resolution ----------

const providers = []; // ordered; resolution stops at the first non-null answer

export function registerCodeNavProvider(provider) {
  providers.push(provider);
}

// Test seam: drop every provider (including the built-ins).
export function clearCodeNavProviders() {
  providers.length = 0;
}

async function resolveVia(method, ctx) {
  for (const provider of providers) {
    const fn = provider?.[method];
    if (typeof fn !== "function") continue;
    let result;
    try {
      result = await fn.call(provider, ctx);
    } catch {
      result = null;
    }
    if (result != null) return result;
  }
  return [];
}

export function resolveDefinitions(ctx) {
  return resolveVia("provideDefinitions", ctx);
}

export function resolveReferences(ctx) {
  return resolveVia("provideReferences", ctx);
}

// ---------- built-in provider: the server (language server / LSP) ----------

const serverProvider = {
  async provideDefinitions(ctx) {
    return fromServer("definition", ctx);
  },
  async provideReferences(ctx) {
    return fromServer("references", ctx);
  },
};

async function fromServer(kind, ctx) {
  // The endpoint speaks 0-based line/character (LSP); the UI is 1-based lines.
  const res = await fetchCodeNavLocations(kind, ctx.path, ctx.language, ctx.line - 1, ctx.column);
  if (!res || res.available !== true) return null;
  return (res.locations ?? []).map(l => ({ path: l.path, line: l.line, column: l.character, text: l.text }));
}

// ---------- built-in provider: the heuristic fallback ----------

const heuristicProvider = {
  provideDefinitions(ctx) {
    const lines = String(ctx.sourceText ?? "").split("\n");
    return findDeclarations(ctx.sourceText, ctx.language, ctx.symbol).map(d => ({
      path: ctx.path,
      line: d.line,
      column: d.column,
      text: lines[d.line - 1],
    }));
  },
  async provideReferences(ctx) {
    const { matches } = await searchFiles(ctx.symbol);
    return findReferences(matches ?? [], ctx.language, ctx.symbol).map(m => ({ path: m.path, line: m.line, text: m.text }));
  },
};

// ---------- heuristic helpers (also the heuristic extension API) ----------

// language id -> (sourceText, symbolName) => [{ line, column }]
const declarationFinders = new Map();
// language id -> (matches, symbolName) => matches
const referenceRefiners = new Map();

export function registerDeclarationFinder(languages, finder) {
  for (const language of Array.isArray(languages) ? languages : [languages]) {
    declarationFinders.set(language, finder);
  }
}

export function registerReferenceRefiner(languages, refiner) {
  for (const language of Array.isArray(languages) ? languages : [languages]) {
    referenceRefiners.set(language, refiner);
  }
}

export function findDeclarations(sourceText, language, symbolName) {
  if (!isIdentifierName(symbolName)) return [];
  const finder = language ? declarationFinders.get(language) : null;
  if (!finder) return [];
  try {
    return finder(String(sourceText ?? ""), symbolName) ?? [];
  } catch {
    return [];
  }
}

// `rawMatches` is the server's full-text search result for `symbolName`
// ([{ path, line, text }, ...]): a case-insensitive substring search, so it
// over-matches (`state` hits `Stateful`, `restate`). Keep only whole-word,
// case-exact occurrences, then let a per-language refiner narrow further.
export function filterReferences(rawMatches, symbolName) {
  if (!isIdentifierName(symbolName)) return [];
  const wholeWord = new RegExp(`(?<![\\w$])${escapeRegExp(symbolName)}(?![\\w$])`);
  return (rawMatches ?? []).filter(m => wholeWord.test(m?.text ?? ""));
}

export function findReferences(rawMatches, language, symbolName) {
  const base = filterReferences(rawMatches, symbolName);
  const refiner = language ? referenceRefiners.get(language) : null;
  if (!refiner) return base;
  try {
    return refiner(base, symbolName) ?? base;
  } catch {
    return base;
  }
}

// Each rule is a regex source string containing exactly one `(?<name>NAME)`
// placeholder; `NAME` is replaced by the (escaped) symbol at lookup time, and
// the `d` flag gives us the matched group's start offset for the column.
function makeDeclarationFinder(ruleSources) {
  return function find(sourceText, symbolName) {
    const escaped = escapeRegExp(symbolName);
    const rules = ruleSources.map(src => new RegExp(src.replace("NAME", escaped), "d"));
    const results = [];
    const lines = String(sourceText ?? "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const rule of rules) {
        const m = rule.exec(lines[i]);
        const span = m?.indices?.groups?.name;
        if (span) {
          results.push({ line: i + 1, column: span[0] });
          break; // one declaration per line is enough
        }
      }
    }
    return results;
  };
}

const JS_DECLARATION_RULES = [
  String.raw`\b(?:async\s+)?function\s*\*?\s*(?<name>NAME)\b`,
  String.raw`\bclass\s+(?<name>NAME)\b`,
  String.raw`\binterface\s+(?<name>NAME)\b`,
  String.raw`\b(?:type|enum)\s+(?<name>NAME)\b`,
  String.raw`\b(?:const|let|var)\s+(?<name>NAME)\b`,
  // import { NAME }, import NAME from …, import * as NAME — the local binding.
  String.raw`\bimport\b[^;'"]*\b(?<name>NAME)\b`,
];

const GO_DECLARATION_RULES = [
  String.raw`\bfunc\s+(?<name>NAME)\b`,
  String.raw`\bfunc\s*\([^)]*\)\s*(?<name>NAME)\b`,
  String.raw`\btype\s+(?<name>NAME)\b`,
  String.raw`\b(?:var|const)\s+(?<name>NAME)\b`,
  // Short variable declaration: `x := …`, `x, y := …` (NAME first of a group).
  String.raw`(?:^|[\s(,;])(?<name>NAME)\s*(?:,[^=\n]*)?:=`,
];

registerDeclarationFinder(["javascript", "typescript", "jsx", "tsx"], makeDeclarationFinder(JS_DECLARATION_RULES));
registerDeclarationFinder("go", makeDeclarationFinder(GO_DECLARATION_RULES));

// Register the built-ins last: the server provider is preferred, the heuristic
// is the fallback. (clearCodeNavProviders + re-registering lets tests reorder.)
registerCodeNavProvider(serverProvider);
registerCodeNavProvider(heuristicProvider);
