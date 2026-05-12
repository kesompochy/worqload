import { test, expect } from "bun:test";
import {
  highlightCode,
  languageForPath,
  registerHighlighter,
  registerLanguageExtension,
} from "../web/syntax-highlight.js";

test("languageForPath resolves common source extensions", () => {
  expect(languageForPath("src/web-server.ts")).toBe("typescript");
  expect(languageForPath("a/b/c.tsx")).toBe("typescript");
  expect(languageForPath("script.js")).toBe("javascript");
  expect(languageForPath("mod.mjs")).toBe("javascript");
  expect(languageForPath("main.go")).toBe("go");
  expect(languageForPath("lib.rs")).toBe("rust");
  expect(languageForPath("App.java")).toBe("java");
  expect(languageForPath("run.py")).toBe("python");
  expect(languageForPath("data.json")).toBe("json");
  expect(languageForPath("deploy.sh")).toBe("shell");
  expect(languageForPath("style.css")).toBe("css");
  expect(languageForPath("index.html")).toBe("html");
  expect(languageForPath("config.yml")).toBe("yaml");
  expect(languageForPath("config.yaml")).toBe("yaml");
});

test("languageForPath is case-insensitive on the extension", () => {
  expect(languageForPath("Component.TSX")).toBe("typescript");
  expect(languageForPath("Foo.JS")).toBe("javascript");
});

test("languageForPath uses the basename, not the whole path", () => {
  expect(languageForPath("dir.with.dots/file")).toBeNull();
  expect(languageForPath("a/b.dir/c.ts")).toBe("typescript");
});

test("languageForPath returns null for unknown or extension-less paths", () => {
  expect(languageForPath("README.md")).toBeNull();
  expect(languageForPath("Makefile")).toBeNull();
  expect(languageForPath("noext")).toBeNull();
  expect(languageForPath("weird.unknownext")).toBeNull();
  expect(languageForPath("")).toBeNull();
  expect(languageForPath(null)).toBeNull();
});

test("highlightCode HTML-escapes when no highlighter is registered for the language", () => {
  expect(highlightCode("a < b > c & d", "no-such-language")).toBe("a &lt; b &gt; c &amp; d");
  expect(highlightCode("<x>", null)).toBe("&lt;x&gt;");
  expect(highlightCode("", "javascript")).toBe("");
});

test("registerHighlighter installs a highlighter whose output is used verbatim", () => {
  registerHighlighter("custom-test-lang", (code) => `<mark>${code}</mark>`);
  // The highlighter is trusted to return safe HTML; the caller does not re-escape it.
  expect(highlightCode(" x ", "custom-test-lang")).toBe("<mark> x </mark>");
});

test("registerHighlighter accepts a list of language ids", () => {
  registerHighlighter(["alias-a-test", "alias-b-test"], () => "TOKENIZED");
  expect(highlightCode("anything", "alias-a-test")).toBe("TOKENIZED");
  expect(highlightCode("anything", "alias-b-test")).toBe("TOKENIZED");
});

test("highlightCode falls back to escaped source when a highlighter throws", () => {
  registerHighlighter("throwing-test-lang", () => {
    throw new Error("boom");
  });
  expect(highlightCode("a < b", "throwing-test-lang")).toBe("a &lt; b");
});

test("registerLanguageExtension wires new file extensions to a language", () => {
  registerHighlighter("ext-test-lang", (code) => `[${code}]`);
  registerLanguageExtension("xyztest", "ext-test-lang");
  expect(languageForPath("file.xyztest")).toBe("ext-test-lang");
  expect(highlightCode("z", languageForPath("file.xyztest"))).toBe("[z]");
});

// --- bundled default highlighter ---

test("default highlighter marks keywords, numbers, strings and comments for c-like code", () => {
  const out = highlightCode("const n = 42; // note <x>", "javascript");
  expect(out).toContain('<span class="hl-keyword">const</span>');
  expect(out).toContain('<span class="hl-number">42</span>');
  expect(out).toContain('<span class="hl-comment">// note &lt;x&gt;</span>');
  // bare identifiers and operators stay plain text, with HTML metacharacters escaped
  expect(highlightCode("a < b && c", "javascript")).toBe("a &lt; b &amp;&amp; c");
});

test("default highlighter recognises string literals without escaping their quotes", () => {
  expect(highlightCode('s = "hi";', "typescript")).toContain('<span class="hl-string">"hi"</span>');
  const single = highlightCode("s = 'hi'", "javascript");
  expect(single).toContain("hl-string");
  expect(single).toContain("'hi'");
});

test("default highlighter uses per-language comment syntax", () => {
  expect(highlightCode("# a comment", "python")).toBe('<span class="hl-comment"># a comment</span>');
  expect(highlightCode("def f():", "python")).toContain('<span class="hl-keyword">def</span>');
  // '#' is not a comment in c-like languages
  expect(highlightCode("a # b", "javascript")).toBe("a # b");
});

test("default highlighter colours JSON literals and numbers", () => {
  const out = highlightCode('{"k": 42, "ok": true}', "json");
  expect(out).toContain('<span class="hl-string">"k"</span>');
  expect(out).toContain('<span class="hl-number">42</span>');
  expect(out).toContain('<span class="hl-keyword">true</span>');
});

test("wrapIdentifiers wraps plain identifiers (not keywords/strings/numbers) in tok-ident spans", () => {
  const out = highlightCode("const x = foo(bar);", "javascript", { wrapIdentifiers: true });
  expect(out).toContain('<span class="hl-keyword">const</span>');
  expect(out).toContain('<span class="tok-ident">x</span>');
  expect(out).toContain('<span class="tok-ident">foo</span>');
  expect(out).toContain('<span class="tok-ident">bar</span>');
  // keywords stay keywords, not idents
  expect(out).not.toContain('<span class="tok-ident">const</span>');
});

test("wrapIdentifiers leaves identifiers inside strings and comments alone", () => {
  expect(highlightCode('s = "foo bar";', "javascript", { wrapIdentifiers: true }))
    .toBe('<span class="tok-ident">s</span> = <span class="hl-string">"foo bar"</span>;');
  expect(highlightCode("// foo bar", "javascript", { wrapIdentifiers: true }))
    .toBe('<span class="hl-comment">// foo bar</span>');
});

test("wrapIdentifiers defaults off — output is unchanged without the option", () => {
  expect(highlightCode("a < b && c", "javascript")).toBe("a &lt; b &amp;&amp; c");
  expect(highlightCode("a < b && c", "javascript", {})).toBe("a &lt; b &amp;&amp; c");
});

test("default highlighter colours markup tag names and escapes the angle brackets", () => {
  const out = highlightCode('<div class="x">text</div>', "html");
  expect(out).toContain('<span class="hl-keyword">div</span>');
  expect(out).toContain('<span class="hl-string">"x"</span>');
  expect(out).toContain("&lt;");
  expect(out).toContain("&gt;");
  expect(out).not.toContain("<div");
});
