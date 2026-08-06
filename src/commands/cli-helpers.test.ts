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

