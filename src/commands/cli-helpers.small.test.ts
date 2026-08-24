import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentEndpoint, requireFlag, optionalFlag, collectFlag } from "./cli-helpers";
import { cleanupAll, makeTmpDir } from "../test-helpers";

afterEach(() => {
  delete process.env.WORQLOAD_ENDPOINT;
  delete process.env.WORQLOAD_ENDPOINT_FILE;
  return cleanupAll();
});

test("requireFlag returns the value following the flag", () => {
  expect(requireFlag(["--slug", "plan", "--re", "001-x.md"], "--slug")).toBe("plan");
});

test("optionalFlag returns the value when present and undefined when absent", () => {
  expect(optionalFlag(["--slug", "plan", "--re", "001-x.md"], "--re")).toBe("001-x.md");
  expect(optionalFlag(["--slug", "plan"], "--re")).toBeUndefined();
});

test("collectFlag gathers every value of a flag passed more than once", () => {
  expect(collectFlag(["--image", "a.png", "--slug", "x", "--image", "b.png"], "--image")).toEqual(["a.png", "b.png"]);
  expect(collectFlag(["--slug", "x"], "--image")).toEqual([]);
});
