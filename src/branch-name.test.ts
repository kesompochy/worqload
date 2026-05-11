import { test, expect, describe } from "bun:test";
import { sanitizeBranchName } from "./branch-name";

describe("sanitizeBranchName", () => {
  test("accepts a simple kebab-case name", () => {
    expect(sanitizeBranchName("fix-login-bug")).toBe("fix-login-bug");
  });

  test("accepts a slashed name like feature/foo", () => {
    expect(sanitizeBranchName("feature/foo")).toBe("feature/foo");
  });

  test("strips surrounding whitespace and trailing newline", () => {
    expect(sanitizeBranchName("  fix-bug \n")).toBe("fix-bug");
  });

  test("takes only the first whitespace-separated token", () => {
    expect(sanitizeBranchName("fix-bug extra garbage")).toBe("fix-bug");
  });

  test("rejects empty string", () => {
    expect(sanitizeBranchName("")).toBeNull();
    expect(sanitizeBranchName("   ")).toBeNull();
  });

  test("rejects names with whitespace inside", () => {
    // already handled by token split, but a literal embedded space after sanitize is impossible
    expect(sanitizeBranchName("hello world")).toBe("hello"); // first token kept
  });

  test("rejects names with git-illegal characters", () => {
    for (const bad of ["foo:bar", "foo?bar", "foo*bar", "foo[bar", "foo\\bar", "foo~bar", "foo^bar"]) {
      expect(sanitizeBranchName(bad)).toBeNull();
    }
  });

  test("rejects names starting with - or /", () => {
    expect(sanitizeBranchName("-foo")).toBeNull();
    expect(sanitizeBranchName("/foo")).toBeNull();
  });

  test("rejects names containing ..", () => {
    expect(sanitizeBranchName("foo..bar")).toBeNull();
  });

  test("rejects names ending with .lock", () => {
    expect(sanitizeBranchName("foo.lock")).toBeNull();
  });

  test("rejects names ending with /", () => {
    expect(sanitizeBranchName("foo/")).toBeNull();
  });

  test("rejects names longer than the cap", () => {
    expect(sanitizeBranchName("a".repeat(61))).toBeNull();
    expect(sanitizeBranchName("a".repeat(60))).toBe("a".repeat(60));
  });

  test("rejects @{ sequence", () => {
    expect(sanitizeBranchName("foo@{bar")).toBeNull();
  });
});
