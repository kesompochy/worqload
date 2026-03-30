import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rmdir } from "node:fs/promises";
import { withLock, lockPathFor } from "./lock";

function tmpFilePath(): string {
  return join(tmpdir(), `worqload-lock-test-${crypto.randomUUID()}.json`);
}

test("lockPathFor appends .lock suffix", () => {
  expect(lockPathFor("tasks.json")).toBe("tasks.json.lock");
});

test("withLock serializes concurrent operations", async () => {
  const filePath = tmpFilePath();
  const order: number[] = [];

  const task = (id: number, delayMs: number) =>
    withLock(filePath, async () => {
      order.push(id);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(id);
    });

  await Promise.all([task(1, 100), task(2, 10)]);

  // Each task pushes its id twice (start, end).
  // Serialized execution means pairs are not interleaved.
  expect(order).toHaveLength(4);
  const first = order[0];
  expect(order[1]).toBe(first);
});

test("withLock releases lock after error", async () => {
  const filePath = tmpFilePath();

  await expect(
    withLock(filePath, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");

  // Lock should be released — second call should succeed immediately
  let executed = false;
  await withLock(filePath, async () => {
    executed = true;
  });
  expect(executed).toBe(true);
});

test("withLock returns the callback value", async () => {
  const filePath = tmpFilePath();
  const result = await withLock(filePath, async () => 42);
  expect(result).toBe(42);
});
