import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { loadSleep, saveSleep, clearSleep, isSleeping, sleepFor } from "./sleep";

function tmpPath(): string {
  return join(tmpdir(), `worqload-sleep-test-${crypto.randomUUID()}.json`);
}

test("loadSleep returns null when file does not exist", async () => {
  expect(await loadSleep(tmpPath())).toBeNull();
});

test("saveSleep persists state and loadSleep reads it", async () => {
  const path = tmpPath();
  const until = new Date(Date.now() + 60000).toISOString();
  await saveSleep({ until }, path);

  const loaded = await loadSleep(path);
  expect(loaded).toEqual({ until });
});

test("clearSleep removes the file", async () => {
  const path = tmpPath();
  await saveSleep({ until: new Date().toISOString() }, path);
  await clearSleep(path);
  expect(await loadSleep(path)).toBeNull();
});

test("clearSleep does nothing when file does not exist", async () => {
  await clearSleep(tmpPath());
});

test("isSleeping returns false when no file", async () => {
  expect(await isSleeping(tmpPath())).toBe(false);
});

test("isSleeping returns true when until is in the future", async () => {
  const path = tmpPath();
  const until = new Date(Date.now() + 60000).toISOString();
  await saveSleep({ until }, path);
  expect(await isSleeping(path)).toBe(true);
});

test("isSleeping returns false when until is in the past", async () => {
  const path = tmpPath();
  const until = new Date(Date.now() - 1000).toISOString();
  await saveSleep({ until }, path);
  expect(await isSleeping(path)).toBe(false);
});

test("sleepFor sets until to minutes from now", async () => {
  const path = tmpPath();
  const before = Date.now();
  const state = await sleepFor(10, path);
  const after = Date.now();

  const untilMs = new Date(state.until).getTime();
  expect(untilMs).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
  expect(untilMs).toBeLessThanOrEqual(after + 10 * 60 * 1000);

  const loaded = await loadSleep(path);
  expect(loaded).toEqual(state);
});
