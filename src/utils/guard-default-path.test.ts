import { test, expect, describe } from "bun:test";
import { resolve } from "path";
import { guardDefaultPath } from "./guard-default-path";

describe("guardDefaultPath", () => {
  test("blocks default .worqload/ path during test runs", () => {
    const result = guardDefaultPath(".worqload/tasks.json", "Store");
    expect(result).toBeUndefined();
  });

  test("blocks default .worqload/archive.json during test runs", () => {
    const result = guardDefaultPath(".worqload/archive.json", "Archive");
    expect(result).toBeUndefined();
  });

  test("allows explicit non-default paths during test runs", () => {
    const explicitPath = "/tmp/worqload-test-store.json";
    const result = guardDefaultPath(explicitPath, "Store");
    expect(result).toBe(explicitPath);
  });

  test("allows paths that do not start with .worqload/", () => {
    const result = guardDefaultPath("other/tasks.json", "Store");
    expect(result).toBe("other/tasks.json");
  });
});
