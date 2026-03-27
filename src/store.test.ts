import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { createTask } from "./task";
import { load, save, loadArchive, appendArchive } from "./store";

function tmpStorePath(): string {
  return join(tmpdir(), `worqload-test-${crypto.randomUUID()}.json`);
}

test("save then load round-trips tasks", async () => {
  const path = tmpStorePath();
  const tasks = [createTask("task A"), createTask("task B")];

  await save(tasks, path);
  const loaded = await load(path);

  expect(loaded).toHaveLength(2);
  expect(loaded[0].title).toBe("task A");
  expect(loaded[1].title).toBe("task B");
});

test("load returns empty array when file does not exist", async () => {
  const path = tmpStorePath();
  const loaded = await load(path);
  expect(loaded).toEqual([]);
});

test("save overwrites previous content", async () => {
  const path = tmpStorePath();
  await save([createTask("first")], path);
  await save([createTask("second")], path);

  const loaded = await load(path);
  expect(loaded).toHaveLength(1);
  expect(loaded[0].title).toBe("second");
});

test("appendArchive appends to existing archive", async () => {
  const path = tmpStorePath();
  await appendArchive([createTask("first")], path);
  await appendArchive([createTask("second")], path);

  const loaded = await loadArchive(path);
  expect(loaded).toHaveLength(2);
  expect(loaded[0].title).toBe("first");
  expect(loaded[1].title).toBe("second");
});

test("loadArchive returns empty array when file does not exist", async () => {
  const path = tmpStorePath();
  expect(await loadArchive(path)).toEqual([]);
});
