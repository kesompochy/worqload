import { test, expect } from "bun:test";
import { TaskQueue } from "../queue";
import { createTask } from "../task";
import { spawn } from "./spawn";

test("spawn skips task that is already done", async () => {
  const queue = new TaskQueue();
  const task = createTask("already done task");
  queue.enqueue(task);
  queue.transition(task.id, "done");

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await spawn(queue, [task.id, "echo", "hello"]);
  } finally {
    console.log = origLog;
  }

  expect(logs.some(l => l.includes("skip"))).toBe(true);
  const updated = queue.get(task.id);
  expect(updated?.status).toBe("done");
});

test("spawn skips task that is already failed", async () => {
  const queue = new TaskQueue();
  const task = createTask("already failed task");
  queue.enqueue(task);
  queue.transition(task.id, "failed");

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await spawn(queue, [task.id, "echo", "hello"]);
  } finally {
    console.log = origLog;
  }

  expect(logs.some(l => l.includes("skip"))).toBe(true);
  const updated = queue.get(task.id);
  expect(updated?.status).toBe("failed");
});

test("spawn skips task that already has an owner", async () => {
  const queue = new TaskQueue();
  const task = createTask("claimed task");
  queue.enqueue(task);
  queue.claim(task.id, "other-agent");

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await spawn(queue, [task.id, "echo", "hello"]);
  } finally {
    console.log = origLog;
  }

  expect(logs.some(l => l.includes("skip"))).toBe(true);
  const updated = queue.get(task.id);
  expect(updated?.owner).toBe("other-agent");
});

test("spawn skips task that is not in observing status", async () => {
  const queue = new TaskQueue();
  const task = createTask("orienting task");
  queue.enqueue(task);
  queue.transition(task.id, "orienting");

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await spawn(queue, [task.id, "echo", "hello"]);
  } finally {
    console.log = origLog;
  }

  expect(logs.some(l => l.includes("skip"))).toBe(true);
  const updated = queue.get(task.id);
  expect(updated?.status).toBe("orienting");
});
