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

test("link with a title still renders as an anchor and carries the title", () => {
  const html = renderMarkdown(`see [docs](https://example.com "the docs")`);
  expect(html).toContain(`<a href="https://example.com"`);
  expect(html).toContain(`title="the docs"`);
  expect(html).toContain(`target="_blank"`);
  expect(html).toContain(">docs</a>");
});

test("table renders thead/tbody with header and body cells", () => {
  const html = renderMarkdown("| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n");
  expect(html).toContain("<table>");
  expect(html).toContain("<thead>");
  expect(html).toContain("<th>A</th>");
  expect(html).toContain("<th>B</th>");
  expect(html).toContain("<tbody>");
  expect(html).toContain("<td>1</td>");
  expect(html).toContain("<td>4</td>");
});

test("table delimiter colons set cell alignment", () => {
  const html = renderMarkdown("| L | C | R |\n| :- | :-: | -: |\n| a | b | c |\n");
  expect(html).toMatch(/<th style="text-align:left;">L<\/th>/);
  expect(html).toMatch(/<th style="text-align:center;">C<\/th>/);
  expect(html).toMatch(/<th style="text-align:right;">R<\/th>/);
  expect(html).toMatch(/<td style="text-align:center;">b<\/td>/);
});

test("table without leading and trailing pipes is recognized", () => {
  const html = renderMarkdown("A | B\n--- | ---\n1 | 2\n");
  expect(html).toContain("<table>");
  expect(html).toContain("<th>A</th>");
  expect(html).toContain("<td>2</td>");
});

test("table cells render inline markup and honor escaped pipes", () => {
  const html = renderMarkdown("| col |\n| --- |\n| **bold** \\| `x` |\n");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("| <code>x</code>");
});

test("table rows carry anchor metadata", () => {
  const html = renderMarkdown("| A |\n| - |\n| 1 |\n| 2 |\n", { anchorPath: "./r.md" });
  // Header row spans the header line and the delimiter line.
  expect(html).toMatch(/<tr [^>]*data-anchor-line="1"[^>]*data-anchor-line-end="2"[^>]*>/);
  expect(html).toMatch(/<tr [^>]*data-anchor-line="3"[^>]*data-anchor-line-end="3"[^>]*>/);
  expect(html).toMatch(/<tr [^>]*data-anchor-line="4"[^>]*data-anchor-line-end="4"[^>]*>/);
});

test("pipe line without a delimiter row stays a paragraph", () => {
  const html = renderMarkdown("a | b | c\nnot a table\n");
  expect(html).toContain("<p");
  expect(html).not.toContain("<table>");
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

test("data-feedback-here marks blocks overlapping a sent-feedback anchor", () => {
  const html = renderMarkdown("# Title\n\nbody line\n", {
    anchorPath: "./r.md",
    feedbackAnchors: [{ lineStart: 3, lineEnd: 3, filename: "004-feedback.md" }],
  });
  // Heading is line 1 (no overlap); paragraph is line 3 (overlap).
  expect(html).not.toMatch(/<h1 [^>]*data-feedback-here/);
  expect(html).toMatch(/<p [^>]*data-feedback-here="004-feedback.md"/);
});

test("data-feedback-here is absent when no feedback anchors are passed", () => {
  const html = renderMarkdown("body\n", { anchorPath: "./r.md" });
  expect(html).not.toContain("data-feedback-here");
});
