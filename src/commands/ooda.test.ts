import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { orient } from "./ooda";
import { createTask, HUMAN_REQUIRED_PREFIX } from "../task";

function tmpPath(label: string): string {
  return join(tmpdir(), `worqload-ooda-cmd-${label}-${crypto.randomUUID()}.json`);
}

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
