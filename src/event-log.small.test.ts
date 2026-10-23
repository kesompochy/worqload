import { test, expect, afterEach } from "bun:test";
import { appendEvent, readEvents } from "./event-log";
import { makeTmpDir, cleanupAll } from "./test-helpers";

afterEach(cleanupAll);

function tmpDir(): string {
  return makeTmpDir("event-log-test");
}

test("appendEvent assigns seq starting at 1", async () => {
  const dir = tmpDir();
  const e = await appendEvent("sess-1", { kind: "session_started", payload: {} }, dir);

  expect(e.seq).toBe(1);
  expect(e.kind).toBe("session_started");
  expect(e.timestamp).toBeDefined();
});

test("appendEvent increments seq across calls", async () => {
  const dir = tmpDir();
  const a = await appendEvent("sess-1", { kind: "session_started", payload: {} }, dir);
  const b = await appendEvent("sess-1", { kind: "claude_assistant_message", payload: { text: "hi" } }, dir);
  const c = await appendEvent("sess-1", { kind: "claude_tool_use", payload: { name: "Read" } }, dir);

  expect(a.seq).toBe(1);
  expect(b.seq).toBe(2);
  expect(c.seq).toBe(3);
});

test("appendEvent isolates seq per session", async () => {
  const dir = tmpDir();
  const a1 = await appendEvent("sess-A", { kind: "session_started", payload: {} }, dir);
  const b1 = await appendEvent("sess-B", { kind: "session_started", payload: {} }, dir);
  const a2 = await appendEvent("sess-A", { kind: "claude_assistant_message", payload: {} }, dir);

  expect(a1.seq).toBe(1);
  expect(b1.seq).toBe(1);
  expect(a2.seq).toBe(2);
});

test("readEvents returns empty array for nonexistent session", async () => {
  const dir = tmpDir();
  const events = await readEvents("nonexistent", 1, dir);
  expect(events).toEqual([]);
});

test("readEvents returns all events when fromSeq <= 1", async () => {
  const dir = tmpDir();
  await appendEvent("sess-1", { kind: "session_started", payload: { a: 1 } }, dir);
  await appendEvent("sess-1", { kind: "claude_assistant_message", payload: { b: 2 } }, dir);

  const events = await readEvents("sess-1", 1, dir);
  expect(events).toHaveLength(2);
  expect(events[0].seq).toBe(1);
  expect(events[0].payload).toEqual({ a: 1 });
  expect(events[1].seq).toBe(2);
  expect(events[1].payload).toEqual({ b: 2 });
});

test("readEvents filters by fromSeq", async () => {
  const dir = tmpDir();
  await appendEvent("sess-1", { kind: "session_started", payload: {} }, dir);
  await appendEvent("sess-1", { kind: "claude_assistant_message", payload: {} }, dir);
  await appendEvent("sess-1", { kind: "claude_tool_use", payload: {} }, dir);

  const events = await readEvents("sess-1", 2, dir);
  expect(events).toHaveLength(2);
  expect(events[0].seq).toBe(2);
  expect(events[1].seq).toBe(3);
});

test("readEvents returns empty when fromSeq exceeds last seq", async () => {
  const dir = tmpDir();
  await appendEvent("sess-1", { kind: "session_started", payload: {} }, dir);

  const events = await readEvents("sess-1", 100, dir);
  expect(events).toEqual([]);
});

test("concurrent appendEvent calls produce unique sequential seq", async () => {
  const dir = tmpDir();
  const N = 20;
  const promises = Array.from({ length: N }, (_, i) =>
    appendEvent("sess-1", { kind: "claude_assistant_message", payload: { i } }, dir),
  );
  const results = await Promise.all(promises);

  const seqs = results.map(e => e.seq).sort((a, b) => a - b);
  expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
});
