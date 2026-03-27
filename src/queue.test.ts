import { test, expect } from "bun:test";
import { createTask } from "./task";
import { TaskQueue } from "./queue";

test("dequeue returns first pending task", () => {
  const queue = new TaskQueue();
  const task1 = createTask("task 1");
  const task2 = createTask("task 2");
  queue.enqueue(task1);
  queue.enqueue(task2);

  const dequeued = queue.dequeue();
  expect(dequeued?.id).toBe(task1.id);
});

test("dequeue skips non-pending tasks", () => {
  const queue = new TaskQueue();
  const task1 = createTask("done task");
  const task2 = createTask("pending task");
  queue.enqueue(task1);
  queue.enqueue(task2);
  queue.update(task1.id, { status: "done" });

  const dequeued = queue.dequeue();
  expect(dequeued?.id).toBe(task2.id);
});

test("dequeue returns undefined when no pending tasks", () => {
  const queue = new TaskQueue();
  const task = createTask("done task");
  queue.enqueue(task);
  queue.update(task.id, { status: "done" });

  expect(queue.dequeue()).toBeUndefined();
});

test("dequeue returns undefined on empty queue", () => {
  const queue = new TaskQueue();
  expect(queue.dequeue()).toBeUndefined();
});

test("update applies patch and refreshes updatedAt", () => {
  const queue = new TaskQueue();
  const task = createTask("task");
  queue.enqueue(task);

  const updated = queue.update(task.id, { status: "observing" });
  expect(updated?.status).toBe("observing");
  expect(updated?.title).toBe("task");
  expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
    new Date(task.updatedAt).getTime(),
  );
});

test("update returns undefined for non-existent id", () => {
  const queue = new TaskQueue();
  expect(queue.update("non-existent", { status: "done" })).toBeUndefined();
});

test("addLog returns undefined for non-existent id", () => {
  const queue = new TaskQueue();
  expect(queue.addLog("non-existent", "observe", "note")).toBeUndefined();
});

test("get returns undefined for non-existent id", () => {
  const queue = new TaskQueue();
  expect(queue.get("non-existent")).toBeUndefined();
});

test("findById returns undefined for non-matching prefix", () => {
  const queue = new TaskQueue();
  const task = createTask("task");
  queue.enqueue(task);

  expect(queue.findById("zzzzz")).toBeUndefined();
});

test("remove returns true and excludes task from list", () => {
  const queue = new TaskQueue();
  const task = createTask("to remove");
  queue.enqueue(task);

  expect(queue.remove(task.id)).toBe(true);
  expect(queue.list()).toEqual([]);
});

test("remove returns false for non-existent id", () => {
  const queue = new TaskQueue();
  expect(queue.remove("non-existent")).toBe(false);
});

test("dequeue skips removed tasks", () => {
  const queue = new TaskQueue();
  const task1 = createTask("first");
  const task2 = createTask("second");
  queue.enqueue(task1);
  queue.enqueue(task2);
  queue.remove(task1.id);

  const dequeued = queue.dequeue();
  expect(dequeued?.id).toBe(task2.id);
});
