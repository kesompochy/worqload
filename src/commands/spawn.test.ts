import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { createTask, ESCALATION_EXIT_CODE, HUMAN_REQUIRED_PREFIX } from "../task";
import { spawn } from "./spawn";
import { load } from "../store";

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

function tmpPath(label: string): string {
  return join(tmpdir(), `worqload-spawn-cmd-${label}-${crypto.randomUUID()}.json`);
}

describe("spawn escalation via exit code", () => {
  test("transitions to waiting_human on exit code 3", async () => {
    const storePath = tmpPath("spawn-escalate");
    const queue = new TaskQueue(storePath);
    const task = createTask("escalation task");
    queue.enqueue(task);
    await queue.save();

    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await spawn(queue, [task.id, "sh", "-c", `echo "Need human help"; exit ${ESCALATION_EXIT_CODE}`]);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("waiting_human");
    expect(updated?.owner).toBeUndefined();
    const orientLog = updated?.logs.find(l => l.phase === "orient" && l.content.includes(HUMAN_REQUIRED_PREFIX));
    expect(orientLog).toBeDefined();
    expect(logs.some(l => l.includes("Escalated"))).toBe(true);
  });
});
