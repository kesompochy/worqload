import { test, expect } from "bun:test";
import { createTask, validateTransition } from "./task";
import type { TaskStatus } from "./task";

test("createTask returns a valid task with defaults", () => {
  const task = createTask("do something");

  expect(task.title).toBe("do something");
  expect(task.status).toBe("pending");
  expect(task.priority).toBe(0);
  expect(task.context).toEqual({});
  expect(task.logs).toEqual([]);
  expect(task.id).toBeDefined();
  expect(task.createdBy).toBeUndefined();
});

test("createTask trims whitespace from title", () => {
  const task = createTask("  spaced  ");
  expect(task.title).toBe("spaced");
});

test("createTask throws on empty title", () => {
  expect(() => createTask("")).toThrow("Task title must not be empty");
  expect(() => createTask("   ")).toThrow("Task title must not be empty");
});

test("createTask accepts custom priority, context, and createdBy", () => {
  const task = createTask("task", { key: "value" }, 5, "agent-1");

  expect(task.priority).toBe(5);
  expect(task.context).toEqual({ key: "value" });
  expect(task.createdBy).toBe("agent-1");
});

test("validateTransition allows valid transitions", () => {
  const valid: [TaskStatus, TaskStatus][] = [
    ["pending", "observing"],
    ["pending", "failed"],
    ["observing", "orienting"],
    ["orienting", "deciding"],
    ["orienting", "waiting_human"],
    ["deciding", "acting"],
    ["deciding", "waiting_human"],
    ["waiting_human", "deciding"],
    ["acting", "done"],
    ["acting", "failed"],
    ["failed", "pending"],
  ];

  for (const [from, to] of valid) {
    expect(() => validateTransition(from, to)).not.toThrow();
  }
});

test("validateTransition rejects invalid transitions", () => {
  const invalid: [TaskStatus, TaskStatus][] = [
    ["pending", "acting"],
    ["done", "pending"],
    ["done", "failed"],
    ["acting", "observing"],
    ["failed", "done"],
  ];

  for (const [from, to] of invalid) {
    expect(() => validateTransition(from, to)).toThrow("Invalid status transition");
  }
});
