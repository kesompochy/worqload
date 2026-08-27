import { describe, expect, test } from "bun:test";
import { validateReportBody } from "./report";

describe("validateReportBody", () => {
  test("accepts Japanese prose", () => {
    expect(validateReportBody("WAF遮断率上昇アラートの原因調査を開始する。")).toBeNull();
  });

  test("accepts longer Japanese prose without punctuation", () => {
    expect(validateReportBody("管理画面APIのエラー率上昇について調査中")).toBeNull();
  });

  test("accepts English prose", () => {
    expect(validateReportBody("Starting investigation of the 5xx error rate increase.")).toBeNull();
  });

  test("accepts multi-line markdown report", () => {
    expect(validateReportBody("## Plan\n\nInvestigate the alert and report findings.")).toBeNull();
  });

  test("rejects separator-style placeholder", () => {
    const result = validateReportBody("--- plan report ---");
    expect(result).not.toBeNull();
  });

  test("rejects kebab-case slug", () => {
    const result = validateReportBody("investigate-disk-usage");
    expect(result).not.toBeNull();
  });

  test("rejects single ASCII word", () => {
    const result = validateReportBody("plan");
    expect(result).not.toBeNull();
  });

  test("rejects dashes-only line", () => {
    const result = validateReportBody("---");
    expect(result).not.toBeNull();
  });

  test("accepts short CJK text", () => {
    expect(validateReportBody("調査開始")).toBeNull();
  });

  test("rejects short ASCII without CJK", () => {
    const result = validateReportBody("hello world");
    expect(result).not.toBeNull();
  });

  test("returns a human-readable error string on rejection", () => {
    const result = validateReportBody("--- plan report ---");
    expect(typeof result).toBe("string");
    expect(result!.length).toBeGreaterThan(0);
  });
});
