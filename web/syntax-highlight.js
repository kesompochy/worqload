// Pluggable syntax highlighting for the worqload diff and file viewers.
//
// Both viewers render every line body through `highlightCode(code, lang)`. With
// no highlighter registered for `lang` it returns the HTML-escaped source
// unchanged, so the viewers always work; registering a highlighter is purely
// additive.
//
// Adding a highlighter (a "syntax highlighting extension") means calling the
// public API from any module the page loads:
//
//   import { registerHighlighter, registerLanguageExtension } from "/assets/syntax-highlight.js";
//   registerHighlighter("toml", code => myTomlHighlighter(code));
//   registerLanguageExtension(["toml"], "toml");
//
// `registerHighlighter(languages, highlight)` — `highlight(code)` receives one
// line of raw source text and must return a safe HTML string; callers do not
// escape its output, so a highlighter is responsible for escaping the text it
// emits (the bundled `escapeHtml` below does the minimal `& < >` form).
//
// Because highlighting runs per line, constructs that span lines (block
// comments, multi-line strings) are only recognised when they open and close on
// the same line. That is a deliberate trade-off: a stateful, whole-file
// highlighter would have to be mapped back onto the diff viewer's
// visible/expanded line ranges, which is far more machinery than these viewers
// warrant.

const highlighters = new Map(); // language id -> (code) => safe HTML

// File extension (lower-case, without the dot) -> language id. Pre-populated
// with common cases; extensions add to it via `registerLanguageExtension`.
const extensionToLanguage = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  cs: "csharp",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  scala: "scala", sc: "scala",
  dart: "dart",
  go: "go",
  rs: "rust",
  php: "php",
  py: "python", pyi: "python", pyw: "python",
  rb: "ruby",
  sh: "shell", bash: "shell", zsh: "shell",
  json: "json", jsonc: "json",
  yml: "yaml", yaml: "yaml", toml: "toml",
  css: "css", scss: "scss", less: "less",
  html: "html", htm: "html", xhtml: "html", xml: "xml", svg: "svg", vue: "vue",
};

export function registerHighlighter(languages, highlight) {
  for (const language of Array.isArray(languages) ? languages : [languages]) {
    highlighters.set(language, highlight);
  }
}

export function registerLanguageExtension(extensions, language) {
  for (const extension of Array.isArray(extensions) ? extensions : [extensions]) {
    extensionToLanguage[String(extension).toLowerCase()] = language;
  }
}

export function languageForPath(path) {
  const name = String(path ?? "").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile like ".gitignore"
  return extensionToLanguage[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function highlightCode(code, language) {
  const text = String(code ?? "");
  const highlight = language ? highlighters.get(language) : null;
  if (!highlight) return escapeHtml(text);
  try {
    return highlight(text);
  } catch {
    return escapeHtml(text);
  }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- bundled default highlighters ----------

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
// Integer / float / hex / binary literal with an optional unit-or-type suffix
// (e.g. 100px, 1.0f, 1_000n). Anchored; callers test it against `code.slice(i)`.
const NUMBER_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)[A-Za-z_]*/;

// A scanner driven by a small per-language config:
//   lineComments              - tokens that start a to-end-of-line comment
//   lineCommentNeedsBoundary  - if true, those tokens only start a comment at
//                               line start or after whitespace (shell-style '#')
//   blockComment              - [open, close] recognised only when both are on
//                               the same line
//   strings                   - quote characters; backslash escapes the next char
//   keywords                  - Set of reserved words to mark as keywords
function makeGenericHighlighter(config) {
  return function highlight(code) {
    const text = String(code ?? "");
    const n = text.length;
    const out = [];
    let i = 0;
    let plainStart = 0;
    const flushPlainTo = (end) => {
      if (end > plainStart) out.push(escapeHtml(text.slice(plainStart, end)));
    };
    const emit = (cls, rawEnd) => {
      const end = Math.min(rawEnd, n);
      flushPlainTo(i);
      out.push(`<span class="hl-${cls}">${escapeHtml(text.slice(i, end))}</span>`);
      i = end;
      plainStart = i;
    };
    while (i < n) {
      const c = text[i];

      let lineComment = null;
      for (const token of config.lineComments) {
        if (text.startsWith(token, i)) { lineComment = token; break; }
      }
      if (lineComment && (!config.lineCommentNeedsBoundary || i === 0 || /\s/.test(text[i - 1]))) {
        emit("comment", n);
        break;
      }

      if (config.blockComment && text.startsWith(config.blockComment[0], i)) {
        const close = text.indexOf(config.blockComment[1], i + config.blockComment[0].length);
        emit("comment", close === -1 ? n : close + config.blockComment[1].length);
        continue;
      }

      if (config.strings.includes(c)) {
        let j = i + 1;
        while (j < n) {
          if (text[j] === "\\") { j += 2; continue; }
          if (text[j] === c) { j++; break; }
          j++;
        }
        emit("string", j);
        continue;
      }

      if (DIGIT.test(c) || (c === "." && DIGIT.test(text[i + 1] ?? ""))) {
        const m = NUMBER_RE.exec(text.slice(i));
        if (m && m[0].length > 0) {
          emit("number", i + m[0].length);
          continue;
        }
      }

      if (IDENTIFIER_START.test(c)) {
        let j = i + 1;
        while (j < n && IDENTIFIER_PART.test(text[j])) j++;
        if (config.keywords.has(text.slice(i, j))) emit("keyword", j);
        else i = j; // a plain identifier stays part of the surrounding plain run
        continue;
      }

      i++;
    }
    flushPlainTo(n);
    return out.join("");
  };
}

// Markup (HTML/XML/SVG): tag names are marked as keywords, quoted attribute
// values as strings, and <!-- --> as comments.
function highlightMarkup(code) {
  const text = String(code ?? "");
  const n = text.length;
  const out = [];
  let i = 0;
  let plainStart = 0;
  let insideTag = false;
  const flushPlainTo = (end) => {
    if (end > plainStart) out.push(escapeHtml(text.slice(plainStart, end)));
  };
  const span = (cls, start, end) => {
    out.push(`<span class="hl-${cls}">${escapeHtml(text.slice(start, end))}</span>`);
  };
  const TAG_OPEN = /^<\/?([A-Za-z][\w:.-]*)/;
  while (i < n) {
    if (!insideTag) {
      if (text.startsWith("<!--", i)) {
        flushPlainTo(i);
        const close = text.indexOf("-->", i + 4);
        const end = close === -1 ? n : close + 3;
        span("comment", i, end);
        i = end;
        plainStart = i;
        continue;
      }
      const m = TAG_OPEN.exec(text.slice(i));
      if (m) {
        flushPlainTo(i);
        const nameStart = i + m[0].length - m[1].length;
        out.push(escapeHtml(text.slice(i, nameStart))); // the "<" or "</"
        span("keyword", nameStart, i + m[0].length);
        i += m[0].length;
        plainStart = i;
        insideTag = true;
        continue;
      }
      i++;
      continue;
    }
    const c = text[i];
    if (c === '"' || c === "'") {
      flushPlainTo(i);
      let j = i + 1;
      while (j < n && text[j] !== c) j++;
      if (j < n) j++;
      span("string", i, j);
      i = j;
      plainStart = i;
      continue;
    }
    if (c === ">") insideTag = false;
    i++;
  }
  flushPlainTo(n);
  return out.join("");
}

const CLIKE_KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "chan", "class", "const", "constexpr",
  "continue", "debugger", "default", "defer", "delete", "do", "dyn", "else", "enum", "export", "extends",
  "extern", "fallthrough", "false", "final", "finally", "fn", "for", "from", "func", "function", "go",
  "goto", "guard", "if", "impl", "implements", "import", "in", "inline", "instanceof", "interface",
  "internal", "is", "let", "loop", "map", "match", "module", "mut", "namespace", "new", "nil", "null",
  "object", "operator", "override", "package", "private", "protected", "pub", "public", "range", "readonly",
  "ref", "return", "sealed", "select", "self", "Self", "static", "struct", "super", "switch", "sync",
  "template", "this", "throw", "throws", "trait", "try", "type", "typedef", "typeof", "union", "unsafe",
  "use", "using", "val", "var", "virtual", "void", "volatile", "when", "where", "while", "with", "yield",
]);
const PYTHON_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "begin", "break", "case", "class", "continue", "def", "del",
  "do", "elif", "elsif", "else", "end", "ensure", "except", "False", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "match", "module", "nil", "None", "nonlocal", "not", "or", "pass",
  "raise", "require", "rescue", "return", "self", "then", "True", "try", "unless", "until", "while", "with",
  "yield",
]);
const SHELL_KEYWORDS = new Set([
  "alias", "break", "case", "cd", "continue", "declare", "do", "done", "echo", "elif", "else", "esac",
  "eval", "exec", "exit", "export", "fi", "for", "function", "if", "in", "local", "read", "readonly",
  "return", "set", "shift", "source", "then", "trap", "unset", "until", "while",
]);
const JSON_KEYWORDS = new Set(["true", "false", "null"]);
const YAML_KEYWORDS = new Set(["true", "false", "null", "yes", "no", "on", "off", "True", "False", "Null", "Yes", "No"]);

const clike = makeGenericHighlighter({
  lineComments: ["//"], lineCommentNeedsBoundary: false, blockComment: ["/*", "*/"],
  strings: ['"', "'", "`"], keywords: CLIKE_KEYWORDS,
});
const python = makeGenericHighlighter({
  lineComments: ["#"], lineCommentNeedsBoundary: false, blockComment: null,
  strings: ['"', "'"], keywords: PYTHON_KEYWORDS,
});
const shell = makeGenericHighlighter({
  lineComments: ["#"], lineCommentNeedsBoundary: true, blockComment: null,
  strings: ['"', "'", "`"], keywords: SHELL_KEYWORDS,
});
const jsonHighlighter = makeGenericHighlighter({
  lineComments: [], lineCommentNeedsBoundary: false, blockComment: null,
  strings: ['"'], keywords: JSON_KEYWORDS,
});
const yaml = makeGenericHighlighter({
  lineComments: ["#"], lineCommentNeedsBoundary: false, blockComment: null,
  strings: ['"', "'"], keywords: YAML_KEYWORDS,
});
const stylesheet = makeGenericHighlighter({
  lineComments: ["//"], lineCommentNeedsBoundary: false, blockComment: ["/*", "*/"],
  strings: ['"', "'"], keywords: new Set(),
});

registerHighlighter(
  ["javascript", "typescript", "jsx", "tsx", "c", "cpp", "csharp", "java", "kotlin", "swift", "scala", "dart", "go", "rust", "php"],
  clike,
);
registerHighlighter(["python", "ruby"], python);
registerHighlighter(["shell", "bash"], shell);
registerHighlighter("json", jsonHighlighter);
registerHighlighter(["yaml", "toml"], yaml);
registerHighlighter(["css", "scss", "less"], stylesheet);
registerHighlighter(["html", "xml", "svg", "vue"], highlightMarkup);
