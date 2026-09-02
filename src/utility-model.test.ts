import { test, expect, describe } from "bun:test";
import { resolveUtilityModel } from "./utility-model";

describe("resolveUtilityModel", () => {
  test("defaults to haiku when WORQLOAD_UTILITY_MODEL is unset", () => {
    expect(resolveUtilityModel({})).toBe("haiku");
  });

  test("defaults to haiku when WORQLOAD_UTILITY_MODEL is blank", () => {
    expect(resolveUtilityModel({ WORQLOAD_UTILITY_MODEL: "   " })).toBe("haiku");
  });

  test("defaults to haiku when WORQLOAD_UTILITY_MODEL is empty string", () => {
    expect(resolveUtilityModel({ WORQLOAD_UTILITY_MODEL: "" })).toBe("haiku");
  });

  test("returns explicit value when set", () => {
    expect(resolveUtilityModel({ WORQLOAD_UTILITY_MODEL: "sonnet" })).toBe("sonnet");
  });

  test("trims whitespace", () => {
    expect(resolveUtilityModel({ WORQLOAD_UTILITY_MODEL: " claude-haiku-4-5 " })).toBe("claude-haiku-4-5");
  });
});
