import { test, expect, describe } from "bun:test";
import { sanitizeLinkLabel } from "./link-label";

describe("sanitizeLinkLabel", () => {
  test("accepts a single lowercase word", () => {
    expect(sanitizeLinkLabel("issue")).toBe("issue");
  });

  test("accepts two lowercase words", () => {
    expect(sanitizeLinkLabel("pull request")).toBe("pull request");
  });

  test("trims whitespace and normalizes case", () => {
    expect(sanitizeLinkLabel("  Issue \n")).toBe("issue");
  });

  test("takes only the first line", () => {
    expect(sanitizeLinkLabel("issue\nsome explanation")).toBe("issue");
  });

  test("rejects empty string", () => {
    expect(sanitizeLinkLabel("")).toBeNull();
    expect(sanitizeLinkLabel("   ")).toBeNull();
  });

  test("rejects labels with special characters", () => {
    expect(sanitizeLinkLabel("issue!")).toBeNull();
    expect(sanitizeLinkLabel("pull_request")).toBeNull();
  });

  test("rejects labels longer than 30 characters", () => {
    expect(sanitizeLinkLabel("a".repeat(31))).toBeNull();
    expect(sanitizeLinkLabel("a".repeat(30))).toBe("a".repeat(30));
  });

  test("rejects labels starting with non-letter", () => {
    expect(sanitizeLinkLabel("123")).toBeNull();
    expect(sanitizeLinkLabel("-foo")).toBeNull();
  });

  test("accepts labels with hyphens", () => {
    expect(sanitizeLinkLabel("pull-request")).toBe("pull-request");
  });
});
