import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { loadJsonFile, saveJsonFile } from "./json-store";

function tmpPath(): string {
  return join(tmpdir(), `worqload-json-store-test-${crypto.randomUUID()}.json`);
}

test("loadJsonFile returns default when file does not exist", async () => {
  const path = tmpPath();
  expect(await loadJsonFile(path, [])).toEqual([]);
  expect(await loadJsonFile(path, null)).toBeNull();
  expect(await loadJsonFile(path, {})).toEqual({});
});

test("saveJsonFile then loadJsonFile round-trips an array", async () => {
  const path = tmpPath();
  const data = [{ id: "1", name: "test" }];

  await saveJsonFile(path, data);
  const loaded = await loadJsonFile(path, []);

  expect(loaded).toEqual(data);
});

test("saveJsonFile then loadJsonFile round-trips an object", async () => {
  const path = tmpPath();
  const data = { key: "value", nested: { a: 1 } };

  await saveJsonFile(path, data);
  const loaded = await loadJsonFile(path, {});

  expect(loaded).toEqual(data);
});

test("saveJsonFile overwrites existing data", async () => {
  const path = tmpPath();

  await saveJsonFile(path, [1, 2]);
  await saveJsonFile(path, [3, 4, 5]);

  const loaded = await loadJsonFile(path, []);
  expect(loaded).toEqual([3, 4, 5]);
});

test("concurrent loadJsonFile calls are serialized by lock", async () => {
  const path = tmpPath();
  await saveJsonFile(path, { count: 0 });

  const results = await Promise.all([
    loadJsonFile(path, {}),
    loadJsonFile(path, {}),
    loadJsonFile(path, {}),
  ]);

  for (const result of results) {
    expect(result).toEqual({ count: 0 });
  }
});
