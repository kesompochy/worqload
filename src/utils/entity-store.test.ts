import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { EntityStore } from "./entity-store";

interface TestEntity {
  id: string;
  name: string;
  value: number;
}

function tmpPath(): string {
  return join(tmpdir(), `worqload-entity-store-test-${crypto.randomUUID()}.json`);
}

function createStore(path?: string): EntityStore<TestEntity> {
  return new EntityStore<TestEntity>(path ?? tmpPath());
}

test("load returns empty array when file does not exist", async () => {
  const store = createStore();
  expect(await store.load()).toEqual([]);
});

test("save then load round-trips", async () => {
  const path = tmpPath();
  const store = createStore(path);
  const items: TestEntity[] = [
    { id: "aaa-111", name: "first", value: 1 },
    { id: "bbb-222", name: "second", value: 2 },
  ];
  await store.save(items);
  expect(await store.load()).toEqual(items);
});

test("add appends entity and persists", async () => {
  const path = tmpPath();
  const store = createStore(path);
  const entity: TestEntity = { id: "abc-123", name: "test", value: 42 };

  const result = await store.add(entity);
  expect(result).toEqual(entity);

  const loaded = await store.load();
  expect(loaded).toHaveLength(1);
  expect(loaded[0]).toEqual(entity);
});

test("add appends to existing items", async () => {
  const path = tmpPath();
  const store = createStore(path);
  await store.add({ id: "aaa", name: "first", value: 1 });
  await store.add({ id: "bbb", name: "second", value: 2 });

  const loaded = await store.load();
  expect(loaded).toHaveLength(2);
});

test("findByIdOrPrefix matches exact id", async () => {
  const store = createStore();
  const items: TestEntity[] = [
    { id: "abc-123-456", name: "target", value: 1 },
    { id: "def-789", name: "other", value: 2 },
  ];
  expect(store.findByIdOrPrefix(items, "abc-123-456")).toEqual(items[0]);
});

test("findByIdOrPrefix matches id prefix", async () => {
  const store = createStore();
  const items: TestEntity[] = [
    { id: "abc-123-456", name: "target", value: 1 },
  ];
  expect(store.findByIdOrPrefix(items, "abc-123")).toEqual(items[0]);
});

test("findByIdOrPrefix returns undefined for no match", async () => {
  const store = createStore();
  const items: TestEntity[] = [
    { id: "abc-123", name: "item", value: 1 },
  ];
  expect(store.findByIdOrPrefix(items, "zzz")).toBeUndefined();
});

test("update modifies entity by id and persists", async () => {
  const path = tmpPath();
  const store = createStore(path);
  await store.add({ id: "abc-123", name: "original", value: 1 });

  const updated = await store.update("abc-123", { name: "updated", value: 99 });
  expect(updated.name).toBe("updated");
  expect(updated.value).toBe(99);

  const loaded = await store.load();
  expect(loaded[0].name).toBe("updated");
  expect(loaded[0].value).toBe(99);
});

test("update matches by id prefix", async () => {
  const path = tmpPath();
  const store = createStore(path);
  await store.add({ id: "abc-123-456", name: "original", value: 1 });

  await store.update("abc-123", { name: "updated" });
  const loaded = await store.load();
  expect(loaded[0].name).toBe("updated");
});

test("update throws for unknown id", async () => {
  const path = tmpPath();
  const store = createStore(path);
  expect(store.update("nonexistent", { name: "x" })).rejects.toThrow("Entity not found: nonexistent");
});

test("remove deletes entity by id and persists", async () => {
  const path = tmpPath();
  const store = createStore(path);
  await store.add({ id: "abc-123", name: "item", value: 1 });

  await store.remove("abc-123");
  const loaded = await store.load();
  expect(loaded).toHaveLength(0);
});

test("remove matches by id prefix", async () => {
  const path = tmpPath();
  const store = createStore(path);
  await store.add({ id: "abc-123-456", name: "item", value: 1 });

  await store.remove("abc-123");
  const loaded = await store.load();
  expect(loaded).toHaveLength(0);
});

test("remove throws for unknown id", async () => {
  const path = tmpPath();
  const store = createStore(path);
  expect(store.remove("nonexistent")).rejects.toThrow("Entity not found: nonexistent");
});

test("custom entity name appears in error messages", async () => {
  const path = tmpPath();
  const store = new EntityStore<TestEntity>(path, "Widget");
  expect(store.update("bad-id", { name: "x" })).rejects.toThrow("Widget not found: bad-id");
  expect(store.remove("bad-id")).rejects.toThrow("Widget not found: bad-id");
});
