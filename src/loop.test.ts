import { test, expect } from "bun:test";
import { createTask } from "./task";
import { TaskQueue } from "./queue";
import { runLoop, type OodaHandlers } from "./loop";

function passthroughHandlers(): OodaHandlers {
  return {
    observe: async (task) => task,
    orient: async (task) => task,
    decide: async (task) => task,
    act: async (task) => task,
  };
}

test("task goes through full OODA cycle", async () => {
  const queue = new TaskQueue();
  const task = createTask("test task");
  queue.enqueue(task);

  await runLoop(queue, passthroughHandlers());

  const result = queue.get(task.id);
  expect(result?.status).toBe("done");
});

test("task is marked failed on handler error", async () => {
  const queue = new TaskQueue();
  const task = createTask("failing task");
  queue.enqueue(task);

  const handlers: OodaHandlers = {
    ...passthroughHandlers(),
    orient: async () => { throw new Error("orient failed"); },
  };

  await runLoop(queue, handlers);

  const result = queue.get(task.id);
  expect(result?.status).toBe("failed");
});

test("runLoop does nothing when queue is empty", async () => {
  const queue = new TaskQueue();
  await runLoop(queue, passthroughHandlers());
  expect(queue.list()).toHaveLength(0);
});

test("addLog records phase logs", () => {
  const queue = new TaskQueue();
  const task = createTask("logged task");
  queue.enqueue(task);

  queue.addLog(task.id, "observe", "found something");
  queue.addLog(task.id, "orient", "it means X");

  const result = queue.get(task.id)!;
  expect(result.logs).toHaveLength(2);
  expect(result.logs[0].phase).toBe("observe");
  expect(result.logs[1].content).toBe("it means X");
});

test("findById matches short prefix", () => {
  const queue = new TaskQueue();
  const task = createTask("prefix task");
  queue.enqueue(task);

  const found = queue.findById(task.id.slice(0, 8));
  expect(found?.id).toBe(task.id);
});
