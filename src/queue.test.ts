import { test, expect } from "bun:test";
import { createTask } from "./task";
import { TaskQueue } from "./queue";

test("dequeue returns first observing task", () => {
  const queue = new TaskQueue();
  const task1 = createTask("task 1");
  const task2 = createTask("task 2");
  queue.enqueue(task1);
  queue.enqueue(task2);

  const dequeued = queue.dequeue();
  expect(dequeued?.id).toBe(task1.id);
});

test("dequeue skips non-observing tasks", () => {
  const queue = new TaskQueue();
  const task1 = createTask("done task");
  const task2 = createTask("observing task");
  queue.enqueue(task1);
  queue.enqueue(task2);
  queue.update(task1.id, { status: "done" });

  const dequeued = queue.dequeue();
  expect(dequeued?.id).toBe(task2.id);
});

test("dequeue returns undefined when no observing tasks", () => {
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

test("createTask throws on empty title", () => {
  expect(() => createTask("")).toThrow("Task title must not be empty");
});

test("createTask throws on whitespace-only title", () => {
  expect(() => createTask("   ")).toThrow("Task title must not be empty");
});

test("createTask trims surrounding whitespace from title", () => {
  const task = createTask("  hello world  ");
  expect(task.title).toBe("hello world");
});

test("transition changes status for valid transition", () => {
  const queue = new TaskQueue();
  const task = createTask("transition task");
  queue.enqueue(task);

  const updated = queue.transition(task.id, "orienting");
  expect(updated?.status).toBe("orienting");
});

test("transition throws on invalid transition", () => {
  const queue = new TaskQueue();
  const task = createTask("invalid transition");
  queue.enqueue(task);

  expect(() => queue.transition(task.id, "acting")).toThrow("Invalid status transition: observing → acting");
});

test("transition returns undefined for non-existent id", () => {
  const queue = new TaskQueue();
  expect(queue.transition("non-existent", "observing")).toBeUndefined();
});

test("dequeue returns highest priority observing task", () => {
  const queue = new TaskQueue();
  const low = createTask("low priority", {}, 1);
  const high = createTask("high priority", {}, 10);
  const medium = createTask("medium priority", {}, 5);
  queue.enqueue(low);
  queue.enqueue(high);
  queue.enqueue(medium);

  expect(queue.dequeue()?.id).toBe(high.id);
});

test("dequeue returns earliest task when priorities are equal", () => {
  const queue = new TaskQueue();
  const first = createTask("first", {}, 0);
  const second = createTask("second", {}, 0);
  queue.enqueue(first);
  queue.enqueue(second);

  expect(queue.dequeue()?.id).toBe(first.id);
});

test("createTask defaults priority to 0", () => {
  const task = createTask("default priority");
  expect(task.priority).toBe(0);
});

test("createTask sets createdBy when provided", () => {
  const task = createTask("agent task", {}, 0, "agent-1");
  expect(task.createdBy).toBe("agent-1");
});

test("createTask omits createdBy when not provided", () => {
  const task = createTask("human task");
  expect(task.createdBy).toBeUndefined();
});

test("claim sets owner on observing task", () => {
  const queue = new TaskQueue();
  const task = createTask("claimable");
  queue.enqueue(task);

  const claimed = queue.claim(task.id, "agent-1");
  expect(claimed?.owner).toBe("agent-1");
});

test("claim throws if task is not observing", () => {
  const queue = new TaskQueue();
  const task = createTask("not observing");
  queue.enqueue(task);
  queue.transition(task.id, "orienting");

  expect(() => queue.claim(task.id, "agent-1")).toThrow("Cannot claim");
});

test("claim throws if already claimed", () => {
  const queue = new TaskQueue();
  const task = createTask("already claimed");
  queue.enqueue(task);
  queue.claim(task.id, "agent-1");

  expect(() => queue.claim(task.id, "agent-2")).toThrow("already claimed");
});

test("dequeue skips claimed tasks", () => {
  const queue = new TaskQueue();
  const claimed = createTask("claimed");
  const free = createTask("free");
  queue.enqueue(claimed);
  queue.enqueue(free);
  queue.claim(claimed.id, "agent-1");

  expect(queue.dequeue()?.id).toBe(free.id);
});

test("unclaim releases owner", () => {
  const queue = new TaskQueue();
  const task = createTask("unclaim me");
  queue.enqueue(task);
  queue.claim(task.id, "agent-1");

  const unclaimed = queue.unclaim(task.id);
  expect(unclaimed?.owner).toBeUndefined();
  expect(queue.dequeue()?.id).toBe(task.id);
});

test("getByMission returns tasks with matching missionId", () => {
  const queue = new TaskQueue();
  const missionId = crypto.randomUUID();
  const t1 = createTask("mission task 1");
  const t2 = createTask("mission task 2");
  const t3 = createTask("other task");
  queue.enqueue(t1);
  queue.enqueue(t2);
  queue.enqueue(t3);
  queue.update(t1.id, { missionId });
  queue.update(t2.id, { missionId });

  const result = queue.getByMission(missionId);
  expect(result).toHaveLength(2);
  expect(result.map(t => t.id).sort()).toEqual([t1.id, t2.id].sort());
});

test("getByMission returns empty array when no tasks match", () => {
  const queue = new TaskQueue();
  const task = createTask("no mission");
  queue.enqueue(task);

  expect(queue.getByMission(crypto.randomUUID())).toEqual([]);
});

test("load clears previously loaded tasks before reading", async () => {
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const { save } = await import("./store");
  const tasksPath = join(tmpdir(), `worqload-queue-load-${crypto.randomUUID()}.json`);
  const archivePath = join(tasksPath.replace("tasks", "archive"));

  const t1 = createTask("persistent");
  const t2 = createTask("removed");
  await save([t1, t2], tasksPath);

  const queue = new TaskQueue(tasksPath, archivePath);
  await queue.load();
  expect(queue.list()).toHaveLength(2);

  await save([t1], tasksPath);
  await queue.load();
  expect(queue.list()).toHaveLength(1);
  expect(queue.get(t2.id)).toBeUndefined();
});
