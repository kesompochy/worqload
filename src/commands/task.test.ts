import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { add } from "./task";

function tmpPath(label: string): string {
  return join(tmpdir(), `worqload-task-cmd-${label}-${crypto.randomUUID()}.json`);
}

describe("add --plan", () => {
  test("sets context.plan to true when --plan flag is provided", async () => {
    const storePath = tmpPath("plan-flag");
    const queue = new TaskQueue(storePath);

    await add(queue, ["my plan task", "--plan"]);

    const tasks = queue.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("my plan task");
    expect(tasks[0].context.plan).toBe(true);
  });

  test("does not set context.plan without --plan flag", async () => {
    const storePath = tmpPath("no-plan");
    const queue = new TaskQueue(storePath);

    await add(queue, ["regular task"]);

    const tasks = queue.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].context.plan).toBeUndefined();
  });

  test("--plan works with other flags", async () => {
    const storePath = tmpPath("plan-priority");
    const queue = new TaskQueue(storePath);

    await add(queue, ["planned", "--plan", "--priority", "5", "--by", "agent"]);

    const tasks = queue.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].context.plan).toBe(true);
    expect(tasks[0].priority).toBe(5);
    expect(tasks[0].createdBy).toBe("agent");
  });
});
