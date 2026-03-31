import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { observe, orient } from "./ooda";
import { createTask, HUMAN_REQUIRED_PREFIX, ESCALATION_EXIT_CODE } from "../task";
import { EscalationError } from "../utils/errors";

function tmpPath(label: string): string {
  return join(tmpdir(), `worqload-ooda-cmd-${label}-${crypto.randomUUID()}.json`);
}

describe("observe", () => {
  test("does not call transition when task is already observing", async () => {
    const queue = new TaskQueue(tmpPath("observe-already-observing"));
    const task = createTask("test task");
    queue.enqueue(task);
    // task starts in "observing" status; calling observe should not throw
    await observe(queue, [task.id, "some observation note"]);

    const updated = queue.get(task.id)!;
    expect(updated.status).toBe("observing");
    expect(updated.logs).toHaveLength(1);
    expect(updated.logs[0].phase).toBe("observe");
    expect(updated.logs[0].content).toBe("some observation note");
  });

  test("adds log without note when no note is provided", async () => {
    const queue = new TaskQueue(tmpPath("observe-no-note"));
    const task = createTask("test task");
    queue.enqueue(task);

    await observe(queue, [task.id]);

    const updated = queue.get(task.id)!;
    expect(updated.status).toBe("observing");
    expect(updated.logs).toHaveLength(0);
  });
});

describe("orient --human", () => {
  test("transitions task to waiting_human and logs the question", async () => {
    const queue = new TaskQueue(tmpPath("orient-human"));
    const task = createTask("test task");
    queue.enqueue(task);

    await orient(queue, [task.id, "--human", "Is this approach correct?"]);

    const updated = queue.get(task.id)!;
    expect(updated.status).toBe("waiting_human");
    expect(updated.logs).toHaveLength(1);
    expect(updated.logs[0].phase).toBe("orient");
    expect(updated.logs[0].content).toBe(`${HUMAN_REQUIRED_PREFIX}Is this approach correct?`);
  });

  test("uses default message when no question is provided", async () => {
    const queue = new TaskQueue(tmpPath("orient-human-default"));
    const task = createTask("test task");
    queue.enqueue(task);

    await orient(queue, [task.id, "--human"]);

    const updated = queue.get(task.id)!;
    expect(updated.status).toBe("waiting_human");
    expect(updated.logs[0].content).toBe(`${HUMAN_REQUIRED_PREFIX}Orientation requires human input`);
  });

  test("rejects --human when called from spawned agent context with EscalationError", async () => {
    const queue = new TaskQueue(tmpPath("orient-human-guard"));
    const task = createTask("test task");
    queue.enqueue(task);

    const original = process.env.WORQLOAD_TASK_ID;
    process.env.WORQLOAD_TASK_ID = "some-task-id";
    try {
      await expect(orient(queue, [task.id, "--human", "question"])).rejects.toThrow(EscalationError);
      const updated = queue.get(task.id)!;
      expect(updated.status).toBe("observing");
    } finally {
      if (original === undefined) delete process.env.WORQLOAD_TASK_ID;
      else process.env.WORQLOAD_TASK_ID = original;
    }
  });

  test("EscalationError carries the human question as message", async () => {
    const queue = new TaskQueue(tmpPath("orient-human-msg"));
    const task = createTask("test task");
    queue.enqueue(task);

    const original = process.env.WORQLOAD_TASK_ID;
    process.env.WORQLOAD_TASK_ID = "some-task-id";
    try {
      await orient(queue, [task.id, "--human", "Is this correct?"]);
      throw new Error("should not reach here");
    } catch (e) {
      expect(e).toBeInstanceOf(EscalationError);
      expect((e as EscalationError).message).toBe("Is this correct?");
      expect((e as EscalationError).exitCode).toBe(ESCALATION_EXIT_CODE);
    } finally {
      if (original === undefined) delete process.env.WORQLOAD_TASK_ID;
      else process.env.WORQLOAD_TASK_ID = original;
    }
  });

  test("regular orient still works without --human", async () => {
    const queue = new TaskQueue(tmpPath("orient-normal"));
    const task = createTask("test task");
    queue.enqueue(task);

    await orient(queue, [task.id, "Analysis complete"]);

    const updated = queue.get(task.id)!;
    expect(updated.status).toBe("orienting");
    expect(updated.logs[0].phase).toBe("orient");
    expect(updated.logs[0].content).toBe("Analysis complete");
  });
});
