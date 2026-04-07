import { test, expect, describe } from "bun:test";
import { createTask, validateTransition, getHumanQuestion, isEligible, isTerminal } from "./task";
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

describe("isEligible", () => {
  test("observing task without owner is eligible", () => {
    const task = createTask("test");
    expect(isEligible(task)).toBe(true);
  });

  test("orienting task without owner is eligible", () => {
    const task = createTask("test");
    task.status = "orienting";
    expect(isEligible(task)).toBe(true);
  });

  test("task with owner is not eligible", () => {
    const task = createTask("test");
    task.owner = "agent-1";
    expect(isEligible(task)).toBe(false);
  });

  test("deciding task is not eligible", () => {
    const task = createTask("test");
    task.status = "deciding";
    expect(isEligible(task)).toBe(false);
  });

  test("acting task is not eligible", () => {
    const task = createTask("test");
    task.status = "acting";
    expect(isEligible(task)).toBe(false);
  });

  test("done task is not eligible", () => {
    const task = createTask("test");
    task.status = "done";
    expect(isEligible(task)).toBe(false);
  });

  test("failed task is not eligible", () => {
    const task = createTask("test");
    task.status = "failed";
    expect(isEligible(task)).toBe(false);
  });

  test("waiting_human task is not eligible", () => {
    const task = createTask("test");
    task.status = "waiting_human";
    expect(isEligible(task)).toBe(false);
  });

  test("task with future retryAfter is not eligible", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const task = createTask("test", { retryAfter: future });
    expect(isEligible(task)).toBe(false);
  });

  test("task with past retryAfter is eligible", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const task = createTask("test", { retryAfter: past });
    expect(isEligible(task)).toBe(true);
  });

  test("task without retryAfter is eligible", () => {
    const task = createTask("test");
    expect(isEligible(task)).toBe(true);
  });
});

describe("isTerminal", () => {
  test("done task is terminal", () => {
    const task = createTask("test");
    task.status = "done";
    expect(isTerminal(task)).toBe(true);
  });

  test("failed task is terminal", () => {
    const task = createTask("test");
    task.status = "failed";
    expect(isTerminal(task)).toBe(true);
  });

  test("observing task is not terminal", () => {
    const task = createTask("test");
    expect(isTerminal(task)).toBe(false);
  });

  test("acting task is not terminal", () => {
    const task = createTask("test");
    task.status = "acting";
    expect(isTerminal(task)).toBe(false);
  });

  test("waiting_human task is not terminal", () => {
    const task = createTask("test");
    task.status = "waiting_human";
    expect(isTerminal(task)).toBe(false);
  });
});
