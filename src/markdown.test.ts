import { test, expect } from "bun:test";
import { renderMarkdown } from "../web/markdown.js";

test("heading produces h-tag with start line", () => {
  const html = renderMarkdown("# Title\n", { anchorPath: "./r.md" });
  expect(html).toContain("<h1");
  expect(html).toContain(">Title</h1>");
  expect(html).toContain(`data-anchor-line="1"`);
  expect(html).toContain(`data-anchor-line-end="1"`);
  expect(html).toContain(`data-anchor-path="./r.md"`);
});

test("paragraph spans its source lines", () => {
  const html = renderMarkdown("line one\nline two\n\nnext block\n", {
    anchorPath: "./r.md",
  });
  expect(html).toMatch(/<p [^>]*data-anchor-line="1"[^>]*data-anchor-line-end="2"[^>]*>/);
  expect(html).toMatch(/<p [^>]*data-anchor-line="4"[^>]*data-anchor-line-end="4"[^>]*>/);
});

test("fenced code block preserves content and lang class", () => {
  const html = renderMarkdown("```ts\nconst a = 1;\n```\n");
  expect(html).toContain(`<pre`);
  expect(html).toContain(`<code class="language-ts">const a = 1;</code>`);
});

test("inline code is preserved verbatim", () => {
  const html = renderMarkdown("use `foo` here");
  expect(html).toContain("<code>foo</code>");
});

test("html in source is escaped", () => {
  const html = renderMarkdown("a <script>b</script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});

test("bold and italic render", () => {
  const html = renderMarkdown("**bold** and *italic* text");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<em>italic</em>");
});

test("unordered list anchors each item", () => {
  const html = renderMarkdown("- one\n- two\n- three\n", { anchorPath: "./r.md" });
  expect(html).toMatch(/<ul>/);
  expect(html).toMatch(/<li [^>]*data-anchor-line="1"[^>]*>one<\/li>/);
  expect(html).toMatch(/<li [^>]*data-anchor-line="2"[^>]*>two<\/li>/);
  expect(html).toMatch(/<li [^>]*data-anchor-line="3"[^>]*>three<\/li>/);
});

test("ordered list renders as ol with anchored items", () => {
  const html = renderMarkdown("1. first\n2. second\n", { anchorPath: "./r.md" });
  expect(html).toContain("<ol>");
  expect(html).toMatch(/<li [^>]*data-anchor-line="1"[^>]*>first<\/li>/);
  expect(html).toMatch(/<li [^>]*data-anchor-line="2"[^>]*>second<\/li>/);
});

test("blockquote wraps body", () => {
  const html = renderMarkdown("> hello\n> world\n");
  expect(html).toContain("<blockquote");
  expect(html).toContain("hello\nworld");
});

test("horizontal rule becomes hr", () => {
  const html = renderMarkdown("a\n\n---\n\nb\n");
  expect(html).toContain("<hr");
});

test("link renders as anchor with target blank", () => {
  const html = renderMarkdown("see [docs](https://example.com)");
  expect(html).toContain(`<a href="https://example.com"`);
  expect(html).toContain(`target="_blank"`);
  expect(html).toContain(">docs</a>");
});

test("anchor metadata is omitted when anchorPath is not given", () => {
  const html = renderMarkdown("# Hi\n");
  expect(html).not.toContain("data-anchor-path");
  expect(html).not.toContain("data-anchor-line");
});

test("aria-current marks only blocks overlapping the current anchor", () => {
  const source = "# Title\n\nbody\n";
  const html = renderMarkdown(source, {
    anchorPath: "./r.md",
    anchor: { path: "./r.md", lineStart: 3, lineEnd: 3 },
  });
  // Heading is line 1 (no overlap); paragraph is line 3 (overlap).
  expect(html).not.toMatch(/<h1 [^>]*aria-current/);
  expect(html).toMatch(/<p [^>]*aria-current="true"/);
});

test("aria-current ignores anchor on a different path", () => {
  const html = renderMarkdown("# Title\n", {
    anchorPath: "./r.md",
    anchor: { path: "./other.md", lineStart: 1, lineEnd: 1 },
  });
  expect(html).not.toContain("aria-current");
});
