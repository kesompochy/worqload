import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "./config";

function tmpPath(): string {
  return join(tmpdir(), `worqload-config-test-${crypto.randomUUID()}.json`);
}

test("loadConfig returns empty object when file does not exist", async () => {
  const config = await loadConfig(tmpPath());
  expect(config).toEqual({});
});

test("loadConfig returns parsed config from file", async () => {
  const path = tmpPath();
  await Bun.write(path, JSON.stringify({ spawn: { pre: ["echo hello"] } }));

  const config = await loadConfig(path);
  expect(config).toEqual({ spawn: { pre: ["echo hello"] } });
});

test("loadConfig reads spawn.worktree boolean", async () => {
  const path = tmpPath();
  await Bun.write(path, JSON.stringify({ spawn: { worktree: true } }));

  const config = await loadConfig(path);
  expect(config.spawn?.worktree).toBe(true);
});
