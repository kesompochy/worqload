import { test, expect, describe } from "bun:test";
import { extractUrls } from "./link-extraction";

describe("extractUrls", () => {
  test("extracts a single URL", () => {
    expect(extractUrls("See https://github.com/foo/bar")).toEqual([
      "https://github.com/foo/bar",
    ]);
  });

  test("extracts multiple URLs", () => {
    const text = "Check https://example.com and http://localhost:3000/path";
    expect(extractUrls(text)).toEqual([
      "https://example.com",
      "http://localhost:3000/path",
    ]);
  });

  test("deduplicates identical URLs", () => {
    const text = "https://example.com twice: https://example.com";
    expect(extractUrls(text)).toEqual(["https://example.com"]);
  });

  test("strips trailing punctuation from prose", () => {
    expect(extractUrls("Visit https://example.com.")).toEqual(["https://example.com"]);
    expect(extractUrls("URL: https://example.com,")).toEqual(["https://example.com"]);
    expect(extractUrls("(https://example.com)")).toEqual(["https://example.com"]);
    expect(extractUrls("https://example.com).")).toEqual(["https://example.com"]);
  });

  test("preserves path segments and query parameters", () => {
    expect(extractUrls("https://github.com/o/r/issues/123?q=open")).toEqual([
      "https://github.com/o/r/issues/123?q=open",
    ]);
  });

  test("preserves fragment identifiers", () => {
    expect(extractUrls("https://example.com/page#section")).toEqual([
      "https://example.com/page#section",
    ]);
  });

  test("returns empty array when no URLs are present", () => {
    expect(extractUrls("No URLs here")).toEqual([]);
    expect(extractUrls("")).toEqual([]);
  });

  test("handles GitHub issue URL in a real-looking prompt", () => {
    const prompt = "https://github.com/kesompochy/worqload/issues/42 を修正してください";
    expect(extractUrls(prompt)).toEqual([
      "https://github.com/kesompochy/worqload/issues/42",
    ]);
  });

  test("handles URLs surrounded by markdown", () => {
    const text = "See [this issue](https://github.com/o/r/issues/1) for details";
    expect(extractUrls(text)).toEqual(["https://github.com/o/r/issues/1"]);
  });
});
