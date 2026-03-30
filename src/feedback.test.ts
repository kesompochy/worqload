import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { addFeedback, loadFeedback, acknowledgeFeedback, resolveFeedback, updateFeedbackMessage, summarizeFeedback } from "./feedback";

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

test("updateFeedbackMessage updates message text", async () => {
  const path = tmpPath();
  const item = await addFeedback("original", "user1", path);

  await updateFeedbackMessage(item.id, "updated", path);
  const loaded = await loadFeedback(path);
  expect(loaded[0].message).toBe("updated");
});

test("updateFeedbackMessage matches by id prefix", async () => {
  const path = tmpPath();
  const item = await addFeedback("original", "user1", path);

  await updateFeedbackMessage(item.id.slice(0, 8), "updated", path);
  const loaded = await loadFeedback(path);
  expect(loaded[0].message).toBe("updated");
});

test("updateFeedbackMessage throws for unknown id", async () => {
  const path = tmpPath();
  expect(updateFeedbackMessage("nonexistent", "msg", path)).rejects.toThrow("Feedback not found");
});

test("summarizeFeedback returns zero counts for empty feedback", async () => {
  const summary = summarizeFeedback([]);
  expect(summary.counts).toEqual({ new: 0, acknowledged: 0, resolved: 0 });
  expect(summary.recentUnresolved).toEqual([]);
  expect(summary.themes).toEqual([]);
});

test("summarizeFeedback counts by status", async () => {
  const path = tmpPath();
  await addFeedback("msg1", "user1", path);
  await addFeedback("msg2", "user2", path);
  const items = await loadFeedback(path);
  items[1].status = "acknowledged";
  const summary = summarizeFeedback(items);
  expect(summary.counts).toEqual({ new: 1, acknowledged: 1, resolved: 0 });
});

test("summarizeFeedback returns up to 5 recent unresolved items", async () => {
  const path = tmpPath();
  for (let i = 0; i < 7; i++) {
    await addFeedback(`msg${i}`, "user1", path);
  }
  const items = await loadFeedback(path);
  // resolve one
  items[0].status = "resolved";
  const summary = summarizeFeedback(items);
  // 6 unresolved, but only 5 returned (most recent first)
  expect(summary.recentUnresolved).toHaveLength(5);
  expect(summary.recentUnresolved[0].message).toBe("msg6");
});

test("summarizeFeedback detects repeated themes from same sender", async () => {
  const path = tmpPath();
  await addFeedback("UI is slow", "alice", path);
  await addFeedback("UI loading is slow", "alice", path);
  await addFeedback("UI performance is slow", "alice", path);
  const items = await loadFeedback(path);
  const summary = summarizeFeedback(items);
  // Repeated sender with 3+ items is a theme
  expect(summary.themes.length).toBeGreaterThanOrEqual(1);
  expect(summary.themes[0]).toContain("alice");
});
