import { test, expect, describe } from "bun:test";
import { resolveUtilityModel } from "./utility-model";

describe("resolveUtilityModel", () => {
  test("returns undefined when WORQLOAD_UTILITY_MODEL is unset", () => {
    expect(resolveUtilityModel({})).toBeUndefined();
  });

  test("returns undefined when WORQLOAD_UTILITY_MODEL is blank", () => {
    expect(resolveUtilityModel({ WORQLOAD_UTILITY_MODEL: "   " })).toBeUndefined();
  });

  test("returns undefined when WORQLOAD_UTILITY_MODEL is empty string", () => {
    expect(resolveUtilityModel({ WORQLOAD_UTILITY_MODEL: "" })).toBeUndefined();
  });

  test("returns trimmed value when set", () => {
    expect(resolveUtilityModel({ WORQLOAD_UTILITY_MODEL: "haiku" })).toBe("haiku");
  });

  test("trims whitespace", () => {
    expect(resolveUtilityModel({ WORQLOAD_UTILITY_MODEL: " claude-haiku-4-5 " })).toBe("claude-haiku-4-5");
  });
});
