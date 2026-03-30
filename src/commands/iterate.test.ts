import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { createTask, SHORT_ID_LENGTH } from "../task";
import { addFeedback } from "../feedback";
import { addReport } from "../reports";
import {
  collectObservation,
  analyzeObservation,
  formatObserveLog,
  auditRecentCompletions,
  type IterateContext,
} from "./iterate";

function tmpPath(prefix: string): string {
  return join(tmpdir(), `worqload-iterate-${prefix}-${crypto.randomUUID()}.json`);
}

function tmpMdPath(prefix: string): string {
  return join(tmpdir(), `worqload-iterate-${prefix}-${crypto.randomUUID()}.md`);
}

function makeContext(overrides: Partial<IterateContext> = {}): IterateContext {
  return {
    feedbackPath: tmpPath("feedback"),
    missionsPath: tmpPath("missions"),
    reportsPath: tmpPath("reports"),
    sourcesPath: tmpPath("sources"),
    principlesPath: tmpMdPath("principles"),
    ...overrides,
  };
}

describe("collectObservation", () => {
  test("returns empty observation when nothing exists", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();
    const ctx = makeContext();

    const obs = await collectObservation(queue, ctx);

    expect(obs.feedbackSummary).toBeDefined();
    expect(obs.feedbackSummary.counts.new).toBe(0);
    expect(obs.activeMissions).toEqual([]);
    expect(obs.sourceResults).toEqual([]);
    expect(obs.principles).toBe("");
    expect(obs.tasks).toEqual([]);
    expect(obs.waitingHumanTasks).toEqual([]);
  });

  test("collects tasks and feedback", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Task A");
    queue.enqueue(t1);
    const feedbackPath = tmpPath("feedback");
    await addFeedback("Fix bug", "user", feedbackPath);
    const ctx = makeContext({ feedbackPath });

    const obs = await collectObservation(queue, ctx);

    expect(obs.tasks).toHaveLength(1);
    expect(obs.tasks[0].title).toBe("Task A");
    expect(obs.feedbackSummary.counts.new).toBe(1);
  });

  test("separates waiting_human tasks", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Needs human");
    queue.enqueue(t1);
    queue.transition(t1.id, "orienting");
    queue.transition(t1.id, "waiting_human");
    const ctx = makeContext();

    const obs = await collectObservation(queue, ctx);

    expect(obs.waitingHumanTasks).toHaveLength(1);
    expect(obs.waitingHumanTasks[0].title).toBe("Needs human");
  });
});

describe("analyzeObservation", () => {
  test("reports empty queue when no tasks", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();
    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("queue_empty");
  });

  test("reports waiting_human when tasks need human input", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Blocked");
    queue.enqueue(t1);
    queue.transition(t1.id, "orienting");
    queue.transition(t1.id, "waiting_human");
    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("waiting_human");
  });

  test("reports has_pending when observing tasks exist", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Ready task");
    queue.enqueue(t1);
    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("has_pending");
  });

  test("excludeTaskId filters out the specified task from observation", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const iterateTask = createTask("Iterate: OODA cycle", {}, 0, "worqload");
    const realTask = createTask("Real task");
    queue.enqueue(iterateTask);
    queue.enqueue(realTask);
    const ctx = makeContext();

    const obs = await collectObservation(queue, ctx, iterateTask.id);

    expect(obs.tasks).toHaveLength(1);
    expect(obs.tasks[0].title).toBe("Real task");
  });

  test("excludeTaskId results in queue_empty when only iterate task exists", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const iterateTask = createTask("Iterate: OODA cycle", {}, 0, "worqload");
    queue.enqueue(iterateTask);
    const ctx = makeContext();

    const obs = await collectObservation(queue, ctx, iterateTask.id);
    const analysis = analyzeObservation(obs);

    expect(obs.tasks).toHaveLength(0);
    expect(analysis).toContain("queue_empty");
  });

  test("includes principle content in analysis when principles exist", async () => {
    const principlesPath = tmpMdPath("principles");
    await Bun.write(principlesPath, "# Principles\n\n- Ship small increments\n- Write tests first");
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();
    const ctx = makeContext({ principlesPath });
    const obs = await collectObservation(queue, ctx);

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("Ship small increments");
    expect(analysis).toContain("Write tests first");
  });

  test("includes principles count in observe log", async () => {
    const principlesPath = tmpMdPath("principles");
    await Bun.write(principlesPath, "# Principles\n\n- Ship small increments\n- Write tests first");
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();
    const ctx = makeContext({ principlesPath });
    const obs = await collectObservation(queue, ctx);

    const log = formatObserveLog(obs);

    expect(log).toContain("principles: 2");
  });

  test("shows 0 principles in observe log when none exist", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();
    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);

    const log = formatObserveLog(obs);

    expect(log).toContain("principles: 0");
  });

  test("omits principles section in analysis when no principles exist", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();
    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);

    const analysis = analyzeObservation(obs);

    expect(analysis).not.toContain("principles:");
  });

  test("includes feedback themes in analysis", async () => {
    const feedbackPath = tmpPath("feedback");
    for (let i = 0; i < 3; i++) {
      await addFeedback(`Issue ${i}`, "alice", feedbackPath);
    }
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();
    const ctx = makeContext({ feedbackPath });
    const obs = await collectObservation(queue, ctx);

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("alice");
  });

  test("groups pending tasks by mission and outputs mission_run", async () => {
    const missionId = crypto.randomUUID();
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Mission task A");
    t1.missionId = missionId;
    const t2 = createTask("Mission task B");
    t2.missionId = missionId;
    queue.enqueue(t1);
    queue.enqueue(t2);
    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);
    obs.activeMissions = [{ id: missionId, name: "Deploy v2", filter: {}, principles: [], priority: 0, status: "active", createdAt: new Date().toISOString() }];

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("has_pending");
    expect(analysis).toContain("mission_run");
    expect(analysis).toContain("Deploy v2");
    expect(analysis).toContain("2 task");
  });

  test("reports unassigned pending tasks separately", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Orphan task");
    queue.enqueue(t1);
    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("has_pending");
    expect(analysis).toContain("unassigned");
    expect(analysis).toContain("1 task");
  });

  test("reports both mission tasks and unassigned tasks", async () => {
    const missionId = crypto.randomUUID();
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Mission task");
    t1.missionId = missionId;
    const t2 = createTask("Orphan task");
    queue.enqueue(t1);
    queue.enqueue(t2);
    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);
    obs.activeMissions = [{ id: missionId, name: "Alpha", filter: {}, principles: [], priority: 0, status: "active", createdAt: new Date().toISOString() }];

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("mission_run");
    expect(analysis).toContain("Alpha");
    expect(analysis).toContain("unassigned: 1 task");
  });

  test("includes suspicious tasks in analysis when audit finds issues", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Suspect task");
    queue.enqueue(t1);
    queue.transition(t1.id, "done");
    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("suspicious");
    expect(analysis).toContain("Suspect task");
  });

  test("includes suspicious count in observe log", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Suspect task");
    queue.enqueue(t1);
    queue.transition(t1.id, "done");
    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);

    const log = formatObserveLog(obs);

    expect(log).toContain("suspicious: 1");
  });

  test("shows suspicious: 0 when no issues found", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();
    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);

    const log = formatObserveLog(obs);

    expect(log).toContain("suspicious: 0");
  });
});

describe("auditRecentCompletions", () => {
  test("returns empty when no done tasks", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Active task");
    queue.enqueue(t1);
    const ctx = makeContext();

    const suspicious = await auditRecentCompletions(queue, ctx);

    expect(suspicious).toEqual([]);
  });

  test("flags done task with no act log", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Quick done");
    queue.enqueue(t1);
    queue.transition(t1.id, "done");
    const ctx = makeContext();

    const suspicious = await auditRecentCompletions(queue, ctx);

    expect(suspicious).toHaveLength(1);
    expect(suspicious[0].taskId).toBe(t1.id);
    expect(suspicious[0].reasons).toContain("no act log");
  });

  test("flags done task with placeholder act log", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Placeholder done");
    queue.enqueue(t1);
    queue.addLog(t1.id, "act", "done");
    queue.transition(t1.id, "done");
    const ctx = makeContext();

    const suspicious = await auditRecentCompletions(queue, ctx);

    expect(suspicious).toHaveLength(1);
    expect(suspicious[0].reasons).toContain("act log lacks substance");
  });

  test("does not flag task with substantive act log", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Good task");
    queue.enqueue(t1);
    queue.addLog(t1.id, "act", "Implemented the new feature with full test coverage");
    queue.transition(t1.id, "done");
    const ctx = makeContext({ reportsPath: undefined });

    const suspicious = await auditRecentCompletions(queue, ctx);

    expect(suspicious).toEqual([]);
  });

  test("ignores tasks completed more than 10 minutes ago", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Old done");
    queue.enqueue(t1);
    queue.transition(t1.id, "done");
    // Manually backdate updatedAt to 15 minutes ago
    const task = queue.get(t1.id)!;
    task.updatedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const ctx = makeContext();

    const suspicious = await auditRecentCompletions(queue, ctx);

    expect(suspicious).toEqual([]);
  });

  test("flags task without report when reportsPath configured", async () => {
    const reportsPath = tmpPath("reports");
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("No report task");
    queue.enqueue(t1);
    queue.addLog(t1.id, "act", "Implemented the full feature correctly");
    queue.transition(t1.id, "done");
    const ctx = makeContext({ reportsPath });

    const suspicious = await auditRecentCompletions(queue, ctx);

    expect(suspicious).toHaveLength(1);
    expect(suspicious[0].reasons).toContain("no report found");
  });

  test("does not flag task with matching report", async () => {
    const reportsPath = tmpPath("reports");
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Has report");
    queue.enqueue(t1);
    queue.addLog(t1.id, "act", "Implemented the full feature correctly");
    queue.transition(t1.id, "done");
    await addReport("Report", `Completed task ${t1.id.slice(0, SHORT_ID_LENGTH)}`, "agent", reportsPath);
    const ctx = makeContext({ reportsPath });

    const suspicious = await auditRecentCompletions(queue, ctx);

    expect(suspicious).toEqual([]);
  });

  test("can flag multiple reasons for one task", async () => {
    const reportsPath = tmpPath("reports");
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Bad task");
    queue.enqueue(t1);
    queue.transition(t1.id, "done");
    const ctx = makeContext({ reportsPath });

    const suspicious = await auditRecentCompletions(queue, ctx);

    expect(suspicious).toHaveLength(1);
    expect(suspicious[0].reasons).toContain("no act log");
    expect(suspicious[0].reasons).toContain("no report found");
  });
});
