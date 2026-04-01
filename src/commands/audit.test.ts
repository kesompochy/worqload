import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { createTask } from "../task";
import { addReport } from "../reports";
import { addFeedback } from "../feedback";
import { runAudit, type AuditResult, type AuditOptions } from "./audit";
import type { RunnerState } from "../mission-runner-state";

function tmpPath(prefix: string): string {
  return join(tmpdir(), `worqload-audit-${prefix}-${crypto.randomUUID()}.json`);
}

function makeOptions(overrides: Partial<AuditOptions> = {}): AuditOptions {
  return {
    reportsPath: tmpPath("reports"),
    runnersPath: tmpPath("runners"),
    ...overrides,
  };
}

function makeRunner(overrides: Partial<RunnerState> = {}): RunnerState {
  return {
    id: crypto.randomUUID(),
    missionId: crypto.randomUUID(),
    missionName: "test-mission",
    pid: 12345,
    status: "running",
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    tasksProcessed: 0,
    consecutiveIdles: 0,
    ...overrides,
  };
}

describe("runAudit", () => {
  test("returns clean audit when no tasks exist", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();

    const result = await runAudit(queue, makeOptions());

    expect(result.stuckTasks).toEqual([]);
    expect(result.suspiciousTasks).toEqual([]);
    expect(result.missingHumanReports).toEqual([]);
    expect(result.staleRunners).toEqual([]);
    expect(result.summary.totalActive).toBe(0);
    expect(result.summary.totalStuck).toBe(0);
    expect(result.summary.totalSuspicious).toBe(0);
    expect(result.summary.healthy).toBe(true);
  });

  test("detects stuck tasks", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();

    const task = createTask("Stuck task");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    // Backdate updatedAt to simulate stuck
    const t = queue.get(task.id)!;
    (t as any).updatedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();

    const result = await runAudit(queue, makeOptions());

    expect(result.stuckTasks).toHaveLength(1);
    expect(result.stuckTasks[0].taskId).toBe(task.id);
    expect(result.stuckTasks[0].status).toBe("orienting");
    expect(result.summary.totalStuck).toBe(1);
    expect(result.summary.healthy).toBe(false);
  });

  test("detects suspicious completions without act logs", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();
    const reportsPath = tmpPath("reports");

    const task = createTask("No act log task");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "deciding");
    queue.transition(task.id, "acting");
    queue.transition(task.id, "done");

    const result = await runAudit(queue, makeOptions({ reportsPath }));

    expect(result.suspiciousTasks).toHaveLength(1);
    expect(result.suspiciousTasks[0].reasons).toContain("no act log");
    expect(result.summary.totalSuspicious).toBe(1);
    expect(result.summary.healthy).toBe(false);
  });

  test("detects suspicious completions with vacuous act logs", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();
    const reportsPath = tmpPath("reports");

    const task = createTask("Vacuous task");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "deciding");
    queue.transition(task.id, "acting");
    queue.addLog(task.id, "act", "no changes");
    queue.transition(task.id, "done");

    const result = await runAudit(queue, makeOptions({ reportsPath }));

    expect(result.suspiciousTasks).toHaveLength(1);
    expect(result.suspiciousTasks[0].reasons).toContain("act log is vacuous");
  });

  test("detects completed feedback tasks missing human reports", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();
    const feedbackPath = tmpPath("feedback");
    const reportsPath = tmpPath("reports");
    const feedback = await addFeedback("Fix the bug", "user", feedbackPath);

    const task = createTask("Fix bug", { feedbackIds: [feedback.id] });
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "deciding");
    queue.transition(task.id, "acting");
    queue.addLog(task.id, "act", "Fixed the bug by updating the validation logic in parser.ts");
    queue.transition(task.id, "done");

    const result = await runAudit(queue, makeOptions({ reportsPath }));

    expect(result.missingHumanReports).toHaveLength(1);
    expect(result.missingHumanReports[0].taskId).toBe(task.id);
  });

  test("does not flag feedback task with human report", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();
    const feedbackPath = tmpPath("feedback");
    const reportsPath = tmpPath("reports");
    const feedback = await addFeedback("Fix the bug", "user", feedbackPath);

    const task = createTask("Fix bug", { feedbackIds: [feedback.id] });
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "deciding");
    queue.transition(task.id, "acting");
    queue.addLog(task.id, "act", "Fixed the bug by updating the validation logic in parser.ts");
    queue.transition(task.id, "done");

    await addReport(
      "Bug fix report",
      "Fixed the validation logic to handle edge cases properly and added tests",
      "agent",
      { path: reportsPath, taskId: task.id, category: "human" as const },
    );

    const result = await runAudit(queue, makeOptions({ reportsPath }));

    expect(result.missingHumanReports).toHaveLength(0);
  });

  test("detects stale mission runners", async () => {
    const runnersPath = tmpPath("runners");
    const staleRunner = makeRunner({
      lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      status: "running",
    });
    await Bun.write(runnersPath, JSON.stringify([staleRunner]));

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();

    const result = await runAudit(queue, makeOptions({ runnersPath }));

    expect(result.staleRunners).toHaveLength(1);
    expect(result.staleRunners[0].runnerId).toBe(staleRunner.id);
    expect(result.summary.healthy).toBe(false);
  });

  test("does not flag healthy runners", async () => {
    const runnersPath = tmpPath("runners");
    const healthyRunner = makeRunner({
      lastHeartbeat: new Date().toISOString(),
      status: "running",
    });
    await Bun.write(runnersPath, JSON.stringify([healthyRunner]));

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();

    const result = await runAudit(queue, makeOptions({ runnersPath }));

    expect(result.staleRunners).toHaveLength(0);
  });

  test("does not flag stopped runners", async () => {
    const runnersPath = tmpPath("runners");
    const stoppedRunner = makeRunner({
      lastHeartbeat: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      status: "stopped",
    });
    await Bun.write(runnersPath, JSON.stringify([stoppedRunner]));

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();

    const result = await runAudit(queue, makeOptions({ runnersPath }));

    expect(result.staleRunners).toHaveLength(0);
  });

  test("summary counts active tasks by status", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();

    const t1 = createTask("Task 1");
    const t2 = createTask("Task 2");
    const t3 = createTask("Task 3");
    queue.enqueue(t1);
    queue.enqueue(t2);
    queue.enqueue(t3);
    queue.transition(t2.id, "orienting");
    queue.transition(t3.id, "orienting");
    queue.transition(t3.id, "deciding");
    queue.transition(t3.id, "acting");

    const result = await runAudit(queue, makeOptions());

    expect(result.summary.totalActive).toBe(3);
    expect(result.summary.byStatus.observing).toBe(1);
    expect(result.summary.byStatus.orienting).toBe(1);
    expect(result.summary.byStatus.acting).toBe(1);
  });

  test("formatAuditReport produces readable output", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();

    const result = await runAudit(queue, makeOptions());
    const { formatAuditReport } = await import("./audit");
    const output = formatAuditReport(result);

    expect(output).toContain("healthy");
  });
});
