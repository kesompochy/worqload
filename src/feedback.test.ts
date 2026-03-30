import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { addFeedback, loadFeedback, acknowledgeFeedback, resolveFeedback } from "./feedback";

function tmpPath(): string {
  return join(tmpdir(), `worqload-feedback-test-${crypto.randomUUID()}.json`);
}

test("loadFeedback returns empty array when file does not exist", async () => {
  expect(await loadFeedback(tmpPath())).toEqual([]);
});

test("addFeedback creates and persists a feedback item", async () => {
  const path = tmpPath();
  const item = await addFeedback("test message", "user1", path);

  expect(item.message).toBe("test message");
  expect(item.from).toBe("user1");
  expect(item.status).toBe("new");

  const loaded = await loadFeedback(path);
  expect(loaded).toHaveLength(1);
  expect(loaded[0].id).toBe(item.id);
});

test("acknowledgeFeedback changes status to acknowledged", async () => {
  const path = tmpPath();
  const item = await addFeedback("msg", "user1", path);

  await acknowledgeFeedback(item.id, path);
  const loaded = await loadFeedback(path);
  expect(loaded[0].status).toBe("acknowledged");
});

test("acknowledgeFeedback matches by id prefix", async () => {
  const path = tmpPath();
  const item = await addFeedback("msg", "user1", path);

  await acknowledgeFeedback(item.id.slice(0, 8), path);
  const loaded = await loadFeedback(path);
  expect(loaded[0].status).toBe("acknowledged");
});

test("acknowledgeFeedback throws for unknown id", async () => {
  const path = tmpPath();
  expect(acknowledgeFeedback("nonexistent", path)).rejects.toThrow("Feedback not found");
});

test("resolveFeedback changes status to resolved", async () => {
  const path = tmpPath();
  const item = await addFeedback("msg", "user1", path);

  await resolveFeedback(item.id, path);
  const loaded = await loadFeedback(path);
  expect(loaded[0].status).toBe("resolved");
});

test("resolveFeedback throws for unknown id", async () => {
  const path = tmpPath();
  expect(resolveFeedback("nonexistent", path)).rejects.toThrow("Feedback not found");
});
