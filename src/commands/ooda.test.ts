import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { observe, orient, done } from "./ooda";
import { createTask, HUMAN_REQUIRED_PREFIX, ESCALATION_EXIT_CODE } from "../task";
import { EscalationError } from "../utils/errors";
import { addFeedback, loadFeedback } from "../feedback";

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
    const original = process.env.WORQLOAD_TASK_ID;
    delete process.env.WORQLOAD_TASK_ID;
    try {
      const queue = new TaskQueue(tmpPath("orient-human"));
      const task = createTask("test task");
      queue.enqueue(task);

      await orient(queue, [task.id, "--human", "Is this approach correct?"]);

      const updated = queue.get(task.id)!;
      expect(updated.status).toBe("waiting_human");
      expect(updated.logs).toHaveLength(1);
      expect(updated.logs[0].phase).toBe("orient");
      expect(updated.logs[0].content).toBe(`${HUMAN_REQUIRED_PREFIX}Is this approach correct?`);
    } finally {
      if (original !== undefined) process.env.WORQLOAD_TASK_ID = original;
    }
  });

  test("uses default message when no question is provided", async () => {
    const original = process.env.WORQLOAD_TASK_ID;
    delete process.env.WORQLOAD_TASK_ID;
    try {
      const queue = new TaskQueue(tmpPath("orient-human-default"));
      const task = createTask("test task");
      queue.enqueue(task);

      await orient(queue, [task.id, "--human"]);

      const updated = queue.get(task.id)!;
      expect(updated.status).toBe("waiting_human");
      expect(updated.logs[0].content).toBe(`${HUMAN_REQUIRED_PREFIX}Orientation requires human input`);
    } finally {
      if (original !== undefined) process.env.WORQLOAD_TASK_ID = original;
    }
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

describe("done", () => {
  test("auto-resolves feedback when task has context.feedbackIds", async () => {
    const feedbackPath = join(tmpdir(), `worqload-ooda-done-feedback-${crypto.randomUUID()}.json`);
    const f1 = await addFeedback("Bug report 1", "alice", feedbackPath);
    const f2 = await addFeedback("Bug report 2", "alice", feedbackPath);
    const f3 = await addFeedback("Unrelated feedback", "bob", feedbackPath);

    const queue = new TaskQueue(tmpPath("done-resolve"));
    const task = createTask("Review feedback: alice", { feedbackIds: [f1.id, f2.id] });
    queue.enqueue(task);

    await done(queue, [task.id, "Reviewed and addressed"], feedbackPath);

    const remaining = await loadFeedback(feedbackPath);
    const resolved = remaining.filter(f => f.status === "resolved");
    expect(resolved).toHaveLength(2);
    expect(resolved.map(f => f.id)).toEqual(expect.arrayContaining([f1.id, f2.id]));
    // f3 remains unaffected
    const bob = remaining.find(f => f.id === f3.id);
    expect(bob!.status).toBe("new");
  });

  test("does not fail when task has no feedbackIds", async () => {
    const queue = new TaskQueue(tmpPath("done-no-feedback"));
    const task = createTask("Normal task");
    queue.enqueue(task);

    await done(queue, [task.id, "Completed"]);

    expect(queue.get(task.id)!.status).toBe("done");
  });

  test("silently ignores already-removed feedback IDs", async () => {
    const feedbackPath = join(tmpdir(), `worqload-ooda-done-missing-${crypto.randomUUID()}.json`);
    const f1 = await addFeedback("Will be removed", "alice", feedbackPath);

    const queue = new TaskQueue(tmpPath("done-missing-feedback"));
    const task = createTask("Review feedback", { feedbackIds: [f1.id, "nonexistent-id"] });
    queue.enqueue(task);

    // Should not throw
    await done(queue, [task.id], feedbackPath);

    expect(queue.get(task.id)!.status).toBe("done");
    const remaining = await loadFeedback(feedbackPath);
    expect(remaining[0].status).toBe("resolved");
  });
});
