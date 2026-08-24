import { test, expect } from "bun:test";
import { parseAnchorRefLine, formatAnchorRefLine } from "./anchor-ref";

test("parseAnchorRefLine reads a single-line anchor", () => {
  expect(parseAnchorRefLine("Re: src/foo.ts:42")).toEqual({ path: "src/foo.ts", lineStart: 42, lineEnd: 42 });
});

test("parseAnchorRefLine reads a range anchor", () => {
  expect(parseAnchorRefLine("Re: src/foo.ts:40-45")).toEqual({ path: "src/foo.ts", lineStart: 40, lineEnd: 45 });
});

test("parseAnchorRefLine handles a report path that itself contains digits and a slash", () => {
  expect(parseAnchorRefLine("Re: ./.worqload-reports/001-foo.md:12-14")).toEqual({
    path: "./.worqload-reports/001-foo.md",
    lineStart: 12,
    lineEnd: 14,
  });
});

test("parseAnchorRefLine rejects non-anchor Re: lines", () => {
  expect(parseAnchorRefLine("Re: command approval 003-foo.md")).toBeNull();
  expect(parseAnchorRefLine("Re: escalation 003-foo.md")).toBeNull();
  expect(parseAnchorRefLine("just some text")).toBeNull();
  expect(parseAnchorRefLine("Re: src/foo.ts:0")).toBeNull();
  expect(parseAnchorRefLine("Re: src/foo.ts:9-3")).toBeNull();
});

test("formatAnchorRefLine round-trips through parseAnchorRefLine", () => {
  for (const anchor of [
    { path: "src/foo.ts", lineStart: 1, lineEnd: 1 },
    { path: "src/foo.ts", lineStart: 40, lineEnd: 45 },
    { path: "./.worqload-reports/001-foo.md", lineStart: 12, lineEnd: 14 },
  ]) {
    expect(parseAnchorRefLine(formatAnchorRefLine(anchor))).toEqual(anchor);
  }
});

test("formatAnchorRefLine collapses a one-line range to a single number", () => {
  expect(formatAnchorRefLine({ path: "a", lineStart: 5, lineEnd: 5 })).toBe("Re: a:5");
});

test("formatAnchorRefLine appends a blockquote when quote is provided", () => {
  const anchor = { path: "src/foo.ts", lineStart: 10, lineEnd: 10, quote: "const x = 1;" };
  expect(formatAnchorRefLine(anchor)).toBe("Re: src/foo.ts:10\n> const x = 1;");
});

test("formatAnchorRefLine wraps multi-line quote with blockquote markers on each line", () => {
  const anchor = { path: "src/foo.ts", lineStart: 10, lineEnd: 12, quote: "line one\nline two\nline three" };
  expect(formatAnchorRefLine(anchor)).toBe("Re: src/foo.ts:10-12\n> line one\n> line two\n> line three");
});

test("formatAnchorRefLine omits blockquote when quote is empty string", () => {
  const anchor = { path: "src/foo.ts", lineStart: 10, lineEnd: 10, quote: "" };
  expect(formatAnchorRefLine(anchor)).toBe("Re: src/foo.ts:10");
});

test("formatAnchorRefLine round-trips through parseAnchorRefLine with quote (quote is stripped)", () => {
  const anchor = { path: "src/foo.ts", lineStart: 10, lineEnd: 12, quote: "some text" };
  const formatted = formatAnchorRefLine(anchor);
  const firstLine = formatted.split("\n")[0];
  expect(parseAnchorRefLine(firstLine)).toEqual({ path: "src/foo.ts", lineStart: 10, lineEnd: 12 });
});
