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

test("resolveAgentEndpoint prefers the file when WORQLOAD_ENDPOINT_FILE points at a readable file", () => {
  const dir = makeTmpDir("endpoint");
  const file = join(dir, "agent-endpoint");
  writeFileSync(file, "http://127.0.0.1:9001\n");
  process.env.WORQLOAD_ENDPOINT = "http://127.0.0.1:3456";
  process.env.WORQLOAD_ENDPOINT_FILE = file;
  expect(resolveAgentEndpoint()).toBe("http://127.0.0.1:9001");
});

test("resolveAgentEndpoint falls back to WORQLOAD_ENDPOINT when the file is missing", () => {
  const dir = makeTmpDir("endpoint");
  process.env.WORQLOAD_ENDPOINT = "http://127.0.0.1:3456";
  process.env.WORQLOAD_ENDPOINT_FILE = join(dir, "does-not-exist");
  expect(resolveAgentEndpoint()).toBe("http://127.0.0.1:3456");
});

test("resolveAgentEndpoint falls back to WORQLOAD_ENDPOINT when the file is empty", () => {
  const dir = makeTmpDir("endpoint");
  const file = join(dir, "agent-endpoint");
  writeFileSync(file, "   \n");
  process.env.WORQLOAD_ENDPOINT = "http://127.0.0.1:3456";
  process.env.WORQLOAD_ENDPOINT_FILE = file;
  expect(resolveAgentEndpoint()).toBe("http://127.0.0.1:3456");
});

test("resolveAgentEndpoint uses WORQLOAD_ENDPOINT when no file env var is set", () => {
  process.env.WORQLOAD_ENDPOINT = "http://127.0.0.1:3456";
  expect(resolveAgentEndpoint()).toBe("http://127.0.0.1:3456");
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
