// Lightweight, pluggable code navigation for the Files viewer: from a symbol
// token, find where it is declared (within the open file) and where it is used
// (across the worktree, via the existing full-text search). Like the syntax
// highlighter (`syntax-highlight.js`), this is deliberately heuristic and
// per-line — no whole-file parser — and additive: a language with no registered
// declaration finder simply offers no "go to definition", and an unrecognised
// language still gets reference search (it is language-agnostic).
//
// Adding support for a language (a "code-nav extension") means calling the
// public API from any module the page loads:
//
//   import { registerDeclarationFinder, registerReferenceRefiner } from "/assets/code-nav.js";
//   registerDeclarationFinder("ruby", (sourceText, symbolName) => [{ line, column }, ...]);
//   registerReferenceRefiner("ruby", (matches, symbolName) => matches.filter(...));
//
// `registerDeclarationFinder(languages, finder)` — `finder(sourceText, symbolName)`
// returns `[{ line, column }]` (1-based line, 0-based column of the symbol).
// `registerReferenceRefiner(languages, refiner)` — `refiner(matches, symbolName)`
// receives the default whole-word-filtered matches and returns a narrowed list
// (e.g. resolving imports); optional.

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

export function isIdentifierName(value) {
  return typeof value === "string" && IDENTIFIER_RE.test(value);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

// ---------- bundled declaration finders ----------

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
