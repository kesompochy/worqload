import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { createTask } from "./task";
import { TaskQueue } from "./queue";
import {
  toA2AState,
  toA2ATask,
  generateAgentCard,
  handleA2ARequest,
} from "./a2a";
import type { A2ATask, JsonRpcResponse } from "./a2a";

const REAL_STORE = ".worqload/tasks.json";
let snapshotBefore: string | null = null;

beforeAll(() => {
  try { snapshotBefore = readFileSync(REAL_STORE, "utf-8"); } catch { snapshotBefore = null; }
});

afterAll(() => {
  let snapshotAfter: string | null = null;
  try { snapshotAfter = readFileSync(REAL_STORE, "utf-8"); } catch { snapshotAfter = null; }
  if (snapshotBefore !== snapshotAfter) {
    throw new Error("A2A tests modified the real .worqload/tasks.json!");
  }
});

function tmpStorePath(): string {
  return join(tmpdir(), `worqload-a2a-test-${crypto.randomUUID()}.json`);
}

describe("toA2AState", () => {
  test("maps OODA phases to working", () => {
    expect(toA2AState("observing")).toBe("working");
    expect(toA2AState("orienting")).toBe("working");
    expect(toA2AState("deciding")).toBe("working");
    expect(toA2AState("acting")).toBe("working");
  });

  test("maps waiting_human to input-required", () => {
    expect(toA2AState("waiting_human")).toBe("input-required");
  });

  test("maps done to completed", () => {
    expect(toA2AState("done")).toBe("completed");
  });

  test("maps failed to failed", () => {
    expect(toA2AState("failed")).toBe("failed");
  });
});

describe("toA2ATask", () => {
  test("converts worqload task to A2A task", () => {
    const task = createTask("test task");
    const a2a = toA2ATask(task);

    expect(a2a.kind).toBe("task");
    expect(a2a.id).toBe(task.id);
    expect(a2a.context_id).toBe(task.id);
    expect(a2a.status.state).toBe("working");
    expect(a2a.status.timestamp).toBe(task.updatedAt);
  });

  test("uses a2a_context_id from context when present", () => {
    const task = createTask("test task", { a2a_context_id: "ctx-123" });
    const a2a = toA2ATask(task);

    expect(a2a.context_id).toBe("ctx-123");
  });

  test("includes logs as history", () => {
    const task = createTask("test task");
    task.logs.push({ phase: "observe", content: "found issue", timestamp: "2025-01-01T00:00:00Z" });
    const a2a = toA2ATask(task);

    expect(a2a.history).toHaveLength(1);
    expect(a2a.history![0].role).toBe("agent");
    expect(a2a.history![0].parts[0]).toEqual({ kind: "text", text: "[observe] found issue" });
  });

  test("includes original A2A message in history", () => {
    const originalMessage = {
      message_id: "msg-1",
      role: "user" as const,
      parts: [{ kind: "text" as const, text: "do something" }],
      kind: "message" as const,
    };
    const task = createTask("test task", { a2a_original_message: originalMessage });
    const a2a = toA2ATask(task);

    expect(a2a.history![0]).toEqual(originalMessage);
  });

  test("omits history when empty", () => {
    const task = createTask("test task");
    const a2a = toA2ATask(task);

    expect(a2a.history).toBeUndefined();
  });

  test("includes HUMAN REQUIRED question as status message when waiting_human", () => {
    const task = createTask("test task");
    task.status = "waiting_human";
    task.logs.push({ phase: "decide", content: "[HUMAN REQUIRED] Should we proceed?", timestamp: "2025-01-01T00:00:00Z" });
    const a2a = toA2ATask(task);

    expect(a2a.status.state).toBe("input-required");
    expect(a2a.status.message).toBeDefined();
    expect(a2a.status.message!.role).toBe("agent");
    expect(a2a.status.message!.parts[0]).toEqual({ kind: "text", text: "Should we proceed?" });
  });

  test("no status message when not waiting_human", () => {
    const task = createTask("test task");
    const a2a = toA2ATask(task);

    expect(a2a.status.message).toBeUndefined();
  });

  test("no status message when waiting_human but no HUMAN REQUIRED log exists", () => {
    const task = createTask("test task");
    task.status = "waiting_human";
    task.logs.push({ phase: "decide", content: "plain log without prefix", timestamp: "2025-01-01T00:00:00Z" });
    const a2a = toA2ATask(task);

    expect(a2a.status.state).toBe("input-required");
    expect(a2a.status.message).toBeUndefined();
  });
});

describe("generateAgentCard", () => {
  test("returns valid agent card", () => {
    const card = generateAgentCard("http://localhost:3456");

    expect(card.name).toBe("worqload");
    expect(card.url).toBe("http://localhost:3456");
    expect(card.protocol_version).toBe("0.2.1");
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.state_transition_history).toBe(true);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("task-management");
  });
});

describe("handleA2ARequest", () => {
  function makeQueue(): TaskQueue {
    return new TaskQueue(tmpStorePath());
  }

  function rpc(method: string, params: Record<string, unknown> = {}) {
    return { jsonrpc: "2.0" as const, id: 1, method, params };
  }

  test("returns parse error for non-object body", async () => {
    const queue = makeQueue();
    const res = await handleA2ARequest(queue, "not json");

    expect(res.error?.code).toBe(-32700);
  });

  test("returns invalid request for missing method", async () => {
    const queue = makeQueue();
    const res = await handleA2ARequest(queue, { jsonrpc: "2.0", id: 1 });

    expect(res.error?.code).toBe(-32600);
  });

  test("returns method not found for unknown method", async () => {
    const queue = makeQueue();
    const res = await handleA2ARequest(queue, rpc("unknown/method"));

    expect(res.error?.code).toBe(-32601);
  });

  describe("message/send", () => {
    test("creates a task from A2A message", async () => {
      const queue = makeQueue();
      const res = await handleA2ARequest(queue, rpc("message/send", {
        message: {
          message_id: "msg-1",
          role: "user",
          parts: [{ kind: "text", text: "investigate the bug" }],
          kind: "message",
        },
      }));

      expect(res.error).toBeUndefined();
      const task = res.result as A2ATask;
      expect(task.kind).toBe("task");
      expect(task.status.state).toBe("working");
      expect(task.id).toBeDefined();

      const worqloadTask = queue.get(task.id);
      expect(worqloadTask).toBeDefined();
      expect(worqloadTask!.title).toBe("investigate the bug");
      expect(worqloadTask!.createdBy).toBe("a2a");
    });

    test("preserves context_id from message", async () => {
      const queue = makeQueue();
      const res = await handleA2ARequest(queue, rpc("message/send", {
        message: {
          message_id: "msg-1",
          role: "user",
          parts: [{ kind: "text", text: "task" }],
          context_id: "ctx-abc",
          kind: "message",
        },
      }));

      const task = res.result as A2ATask;
      expect(task.context_id).toBe("ctx-abc");
    });

    test("rejects message without parts", async () => {
      const queue = makeQueue();
      const res = await handleA2ARequest(queue, rpc("message/send", {
        message: { message_id: "msg-1", role: "user", parts: [], kind: "message" },
      }));

      expect(res.error?.code).toBe(-32600);
    });

    test("rejects request without message", async () => {
      const queue = makeQueue();
      const res = await handleA2ARequest(queue, rpc("message/send", {}));

      expect(res.error?.code).toBe(-32600);
    });

    test("responds to waiting_human task via task_id, transitions to deciding", async () => {
      const queue = makeQueue();
      const task = createTask("need approval", {}, 0, "a2a");
      queue.enqueue(task);
      queue.transition(task.id, "orienting");
      queue.addLog(task.id, "orient", "[HUMAN REQUIRED] Approve this change?");
      queue.transition(task.id, "waiting_human");
      await queue.save();

      const res = await handleA2ARequest(queue, rpc("message/send", {
        message: {
          message_id: "msg-reply",
          role: "user",
          parts: [{ kind: "text", text: "Yes, approved" }],
          task_id: task.id,
          kind: "message",
        },
      }));

      expect(res.error).toBeUndefined();
      const a2aTask = res.result as A2ATask;
      expect(a2aTask.id).toBe(task.id);
      expect(a2aTask.status.state).toBe("working");

      const updated = queue.get(task.id)!;
      expect(updated.status).toBe("deciding");
      const lastLog = updated.logs[updated.logs.length - 1];
      expect(lastLog.phase).toBe("decide");
      expect(lastLog.content).toBe("Yes, approved");
    });

    test("returns input-required when fetching waiting_human task via message/send", async () => {
      const queue = makeQueue();
      const task = createTask("waiting task", {}, 0, "a2a");
      queue.enqueue(task);
      queue.transition(task.id, "orienting");
      queue.addLog(task.id, "decide", "[HUMAN REQUIRED] What should we do?");
      queue.transition(task.id, "waiting_human");
      await queue.save();

      const res = await handleA2ARequest(queue, rpc("tasks/get", { id: task.id }));

      expect(res.error).toBeUndefined();
      const a2aTask = res.result as A2ATask;
      expect(a2aTask.status.state).toBe("input-required");
      expect(a2aTask.status.message).toBeDefined();
      expect(a2aTask.status.message!.parts[0]).toEqual({ kind: "text", text: "What should we do?" });
    });

    test("rejects reply to non-waiting_human task", async () => {
      const queue = makeQueue();
      const task = createTask("active task", {}, 0, "a2a");
      queue.enqueue(task);
      await queue.save();

      const res = await handleA2ARequest(queue, rpc("message/send", {
        message: {
          message_id: "msg-reply",
          role: "user",
          parts: [{ kind: "text", text: "reply" }],
          task_id: task.id,
          kind: "message",
        },
      }));

      expect(res.error?.code).toBe(-32600);
      expect(res.error?.message).toContain("not waiting for human input");
    });

    test("rejects reply to nonexistent task_id", async () => {
      const queue = makeQueue();

      const res = await handleA2ARequest(queue, rpc("message/send", {
        message: {
          message_id: "msg-reply",
          role: "user",
          parts: [{ kind: "text", text: "reply" }],
          task_id: "nonexistent",
          kind: "message",
        },
      }));

      expect(res.error?.code).toBe(-32001);
    });
  });

  describe("tasks/get", () => {
    test("returns task by id", async () => {
      const queue = makeQueue();
      const task = createTask("test task", {}, 0, "a2a");
      queue.enqueue(task);
      await queue.save();

      const res = await handleA2ARequest(queue, rpc("tasks/get", { id: task.id }));

      expect(res.error).toBeUndefined();
      const a2aTask = res.result as A2ATask;
      expect(a2aTask.id).toBe(task.id);
      expect(a2aTask.status.state).toBe("working");
    });

    test("returns task by short id", async () => {
      const queue = makeQueue();
      const task = createTask("test task");
      queue.enqueue(task);
      await queue.save();

      const res = await handleA2ARequest(queue, rpc("tasks/get", { id: task.id.slice(0, 8) }));

      expect(res.error).toBeUndefined();
      expect((res.result as A2ATask).id).toBe(task.id);
    });

    test("returns error for missing task", async () => {
      const queue = makeQueue();
      const res = await handleA2ARequest(queue, rpc("tasks/get", { id: "nonexistent" }));

      expect(res.error?.code).toBe(-32001);
    });

    test("returns error when id is missing", async () => {
      const queue = makeQueue();
      const res = await handleA2ARequest(queue, rpc("tasks/get", {}));

      expect(res.error?.code).toBe(-32600);
    });
  });

  describe("tasks/cancel", () => {
    test("cancels a pending task", async () => {
      const queue = makeQueue();
      const task = createTask("cancel me");
      queue.enqueue(task);
      await queue.save();

      const res = await handleA2ARequest(queue, rpc("tasks/cancel", { id: task.id }));

      expect(res.error).toBeUndefined();
      const a2aTask = res.result as A2ATask;
      expect(a2aTask.status.state).toBe("failed");

      const updated = queue.get(task.id);
      expect(updated!.status).toBe("failed");
    });

    test("returns error for already completed task", async () => {
      const queue = makeQueue();
      const task = createTask("done task");
      queue.enqueue(task);
      queue.transition(task.id, "done");
      await queue.save();

      const res = await handleA2ARequest(queue, rpc("tasks/cancel", { id: task.id }));

      expect(res.error?.code).toBe(-32002);
    });

    test("returns error for nonexistent task", async () => {
      const queue = makeQueue();
      const res = await handleA2ARequest(queue, rpc("tasks/cancel", { id: "nonexistent" }));

      expect(res.error?.code).toBe(-32001);
    });
  });
});
