import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { createTask } from "../task";
import { add, clean } from "./task";

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

describe("add rejects CLI subcommands as titles", () => {
  const origExit = process.exit;
  const origErr = console.error;

  function trapExit(): { code: number | undefined; errors: string[] } {
    const result = { code: undefined as number | undefined, errors: [] as string[] };
    console.error = (...args: unknown[]) => result.errors.push(args.join(" "));
    process.exit = ((c?: number) => { result.code = c ?? 0; throw new Error("exit"); }) as never;
    return result;
  }

  function restore() {
    process.exit = origExit;
    console.error = origErr;
  }

  test("rejects --help", async () => {
    const trap = trapExit();
    try { await add(new TaskQueue(tmpPath("reject-help")), ["--help"]); } catch {} finally { restore(); }
    expect(trap.code).toBe(1);
    expect(trap.errors[0]).toContain("looks like a CLI subcommand");
  });

  test("rejects show <uuid>", async () => {
    const trap = trapExit();
    try { await add(new TaskQueue(tmpPath("reject-show")), ["show", "66911412"]); } catch {} finally { restore(); }
    expect(trap.code).toBe(1);
  });

  test("rejects feedback list", async () => {
    const trap = trapExit();
    try { await add(new TaskQueue(tmpPath("reject-fb")), ["feedback", "list"]); } catch {} finally { restore(); }
    expect(trap.code).toBe(1);
  });

  test("allows normal task titles", async () => {
    const queue = new TaskQueue(tmpPath("allow-normal"));
    await add(queue, ["Fix the feedback rendering bug"]);
    expect(queue.list()).toHaveLength(1);
  });
});

describe("clean", () => {
  test("archives done tasks", async () => {
    const storePath = tmpPath("clean-done");
    const archivePath = tmpPath("clean-done-archive");
    const queue = new TaskQueue(storePath, archivePath);

    const doneTask = createTask("finished task");
    queue.enqueue(doneTask);
    queue.transition(doneTask.id, "orienting");
    queue.transition(doneTask.id, "done");
    await queue.save();

    await clean(queue, []);

    expect(queue.list()).toHaveLength(0);
    const archived = await queue.history();
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe(doneTask.id);
  });

  test("archives failed tasks", async () => {
    const storePath = tmpPath("clean-failed");
    const archivePath = tmpPath("clean-failed-archive");
    const queue = new TaskQueue(storePath, archivePath);

    const failedTask = createTask("broken task");
    queue.enqueue(failedTask);
    queue.transition(failedTask.id, "orienting");
    queue.transition(failedTask.id, "failed");
    await queue.save();

    await clean(queue, []);

    expect(queue.list()).toHaveLength(0);
    const archived = await queue.history();
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe(failedTask.id);
    expect(archived[0].status).toBe("failed");
  });

  test("archives both done and failed tasks together", async () => {
    const storePath = tmpPath("clean-both");
    const archivePath = tmpPath("clean-both-archive");
    const queue = new TaskQueue(storePath, archivePath);

    const doneTask = createTask("done task");
    queue.enqueue(doneTask);
    queue.transition(doneTask.id, "orienting");
    queue.transition(doneTask.id, "done");

    const failedTask = createTask("failed task");
    queue.enqueue(failedTask);
    queue.transition(failedTask.id, "orienting");
    queue.transition(failedTask.id, "failed");

    const activeTask = createTask("still active");
    queue.enqueue(activeTask);

    await queue.save();
    await clean(queue, []);

    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0].id).toBe(activeTask.id);
    const archived = await queue.history();
    expect(archived).toHaveLength(2);
  });

  test("reports nothing to clean when no terminated tasks exist", async () => {
    const storePath = tmpPath("clean-empty");
    const archivePath = tmpPath("clean-empty-archive");
    const queue = new TaskQueue(storePath, archivePath);

    const activeTask = createTask("active task");
    queue.enqueue(activeTask);
    await queue.save();

    await clean(queue, []);

    expect(queue.list()).toHaveLength(1);
  });
});
