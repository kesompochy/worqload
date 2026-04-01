import { test, expect, describe } from "bun:test";
import { createTask, validateTransition, getHumanQuestion } from "./task";
import type { TaskStatus } from "./task";

test("createTask returns a valid task with defaults", () => {
  const task = createTask("do something");

  expect(task.title).toBe("do something");
  expect(task.status).toBe("observing");
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
    ["observing", "orienting"],
    ["orienting", "deciding"],
    ["orienting", "waiting_human"],
    ["deciding", "acting"],
    ["waiting_human", "orienting"],
    ["acting", "done"],
    ["acting", "failed"],
    ["failed", "observing"],
  ];

  for (const [from, to] of valid) {
    expect(() => validateTransition(from, to)).not.toThrow();
  }
});

test("validateTransition rejects invalid transitions", () => {
  const invalid: [TaskStatus, TaskStatus][] = [
    ["done", "observing"],
    ["done", "failed"],
    ["acting", "observing"],
    ["deciding", "waiting_human"],
    ["waiting_human", "deciding"],
    ["failed", "done"],
  ];

  for (const [from, to] of invalid) {
    expect(() => validateTransition(from, to)).toThrow("Invalid status transition");
  }
});

describe("getHumanQuestion", () => {
  test("returns question from waiting_human task with HUMAN REQUIRED log", () => {
    const task = createTask("test task");
    task.status = "waiting_human";
    task.logs.push({ phase: "orient", content: "[HUMAN REQUIRED] Should we proceed?", timestamp: "2025-01-01T00:00:00Z" });

    expect(getHumanQuestion(task)).toBe("Should we proceed?");
  });

  test("returns null for non-waiting_human task", () => {
    const task = createTask("test task");
    task.logs.push({ phase: "orient", content: "[HUMAN REQUIRED] question", timestamp: "2025-01-01T00:00:00Z" });

    expect(getHumanQuestion(task)).toBeNull();
  });

  test("returns null for waiting_human task without HUMAN REQUIRED log", () => {
    const task = createTask("test task");
    task.status = "waiting_human";
    task.logs.push({ phase: "orient", content: "some analysis", timestamp: "2025-01-01T00:00:00Z" });

    expect(getHumanQuestion(task)).toBeNull();
  });

  test("returns latest HUMAN REQUIRED question when multiple exist", () => {
    const task = createTask("test task");
    task.status = "waiting_human";
    task.logs.push({ phase: "orient", content: "[HUMAN REQUIRED] First question?", timestamp: "2025-01-01T00:00:00Z" });
    task.logs.push({ phase: "orient", content: "user answered", timestamp: "2025-01-01T00:01:00Z" });
    task.logs.push({ phase: "orient", content: "[HUMAN REQUIRED] Second question?", timestamp: "2025-01-01T00:02:00Z" });

    expect(getHumanQuestion(task)).toBe("Second question?");
  });

  test("extracts question from A2A-created task", () => {
    const task = createTask("A2A task", {
      a2a_context_id: "ctx-123",
      a2a_original_message: {
        message_id: "msg-1",
        role: "user",
        parts: [{ kind: "text", text: "investigate bug" }],
        kind: "message",
      },
    }, 0, "a2a");
    task.status = "waiting_human";
    task.logs.push({ phase: "observe", content: "found the issue", timestamp: "2025-01-01T00:00:00Z" });
    task.logs.push({ phase: "orient", content: "needs human input", timestamp: "2025-01-01T00:01:00Z" });
    task.logs.push({ phase: "orient", content: "[HUMAN REQUIRED] Approve this change?", timestamp: "2025-01-01T00:02:00Z" });

    expect(getHumanQuestion(task)).toBe("Approve this change?");
  });

  test("returns null for A2A-created task without HUMAN REQUIRED log", () => {
    const task = createTask("A2A task", {
      a2a_context_id: "ctx-123",
      a2a_original_message: {
        message_id: "msg-1",
        role: "user",
        parts: [{ kind: "text", text: "do something" }],
        kind: "message",
      },
    }, 0, "a2a");
    task.status = "waiting_human";

    expect(getHumanQuestion(task)).toBeNull();
  });
});
