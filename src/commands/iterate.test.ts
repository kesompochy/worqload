import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { createTask, SHORT_ID_LENGTH } from "../task";
import { addFeedback, resolveFeedback, loadFeedback } from "../feedback";
import { addReport } from "../reports";
import {
  collectObservation,
  analyzeObservation,
  formatObserveLog,
  auditRecentCompletions,
  generateTasksFromObservation,
  type IterateContext,
  type Observation,
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

  test("includes server log summary in analysis when logs exist", () => {
    const obs: Observation = {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      suspiciousTasks: [],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: {
        totalRequests: 100,
        errorCount: 5,
        errorRate: 0.05,
        avgDurationMs: 42,
        errorPaths: ["/api/tasks", "/api/missions"],
      },
    };

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("server: 100 reqs");
    expect(analysis).toContain("5 errors");
    expect(analysis).toContain("5%");
    expect(analysis).toContain("avg 42ms");
    expect(analysis).toContain("/api/tasks");
    expect(analysis).toContain("/api/missions");
  });

  test("omits server log section when no logs", () => {
    const obs: Observation = {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      suspiciousTasks: [],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
    };

    const analysis = analyzeObservation(obs);

    expect(analysis).not.toContain("server:");
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

describe("generateTasksFromObservation", () => {
  function emptyObservation(): Observation {
    return {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      suspiciousTasks: [],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
    };
  }

  test("creates commit task when uncommitted changes exist", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.uncommittedChanges = " M src/foo.ts\n?? src/bar.ts";

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks).toHaveLength(1);
    expect(result.createdTasks[0]).toContain("Commit");
    const tasks = queue.list();
    expect(tasks.some(t => t.title.includes("Commit"))).toBe(true);
  });

  test("does not create commit task when no uncommitted changes", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.uncommittedChanges = "";

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks.filter(t => t.includes("Commit"))).toHaveLength(0);
  });

  test("does not duplicate commit task when one already exists", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const existing = createTask("Commit uncommitted changes");
    queue.enqueue(existing);
    const obs = emptyObservation();
    obs.uncommittedChanges = " M src/foo.ts";
    obs.tasks = [existing];

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks.filter(t => t.includes("Commit"))).toHaveLength(0);
    expect(queue.list().filter(t => t.title.includes("Commit"))).toHaveLength(1);
  });

  test("creates tasks from new feedback themes", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary = {
      counts: { new: 3, acknowledged: 0, resolved: 0 },
      recentUnresolved: [
        { id: "f1", from: "alice", message: "Fix bug in login", status: "new", createdAt: new Date().toISOString() },
        { id: "f2", from: "alice", message: "Login still broken", status: "new", createdAt: new Date().toISOString() },
        { id: "f3", from: "alice", message: "Login page error", status: "new", createdAt: new Date().toISOString() },
      ],
      themes: ["alice から未解決フィードバックが 3 件"],
    };

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks.some(t => t.includes("feedback"))).toBe(true);
    const feedbackTasks = queue.list().filter(t => t.title.includes("feedback"));
    expect(feedbackTasks.length).toBeGreaterThanOrEqual(1);
  });

  test("does not recreate feedback task when a matching done task exists", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const doneTask = createTask("Review feedback: alice から未解決フィードバックが 3 件");
    queue.enqueue(doneTask);
    queue.transition(doneTask.id, "done");
    const obs = emptyObservation();
    obs.feedbackSummary = {
      counts: { new: 3, acknowledged: 0, resolved: 0 },
      recentUnresolved: [],
      themes: ["alice から未解決フィードバックが 3 件"],
    };

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks.filter(t => t.includes("feedback"))).toHaveLength(0);
  });

  test("does not duplicate feedback task when one already exists", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const existing = createTask("Review feedback: alice から未解決フィードバックが 3 件");
    queue.enqueue(existing);
    const obs = emptyObservation();
    obs.tasks = [existing];
    obs.feedbackSummary = {
      counts: { new: 3, acknowledged: 0, resolved: 0 },
      recentUnresolved: [],
      themes: ["alice から未解決フィードバックが 3 件"],
    };

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks.filter(t => t.includes("feedback"))).toHaveLength(0);
  });

  test("retries failed tasks by transitioning to observing", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const failedTask = createTask("Failed task");
    queue.enqueue(failedTask);
    queue.transition(failedTask.id, "done");
    // Manually set to failed for testing (done→failed is not a valid transition)
    const task = queue.get(failedTask.id)!;
    task.status = "failed";
    task.logs = [];
    const obs = emptyObservation();
    obs.failedTasks = [task];

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.retriedTasks).toHaveLength(1);
    expect(result.retriedTasks[0]).toBe(failedTask.id);
    const updated = queue.get(failedTask.id)!;
    expect(updated.status).toBe("observing");
  });

  test("does not retry failed tasks that already had 2 retries", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const failedTask = createTask("Failed task");
    queue.enqueue(failedTask);
    // Simulate 2 prior retries via act logs
    queue.addLog(failedTask.id, "act", "retry attempt 1 - something happened");
    queue.addLog(failedTask.id, "act", "retry attempt 2 - something happened");
    const task = queue.get(failedTask.id)!;
    task.status = "failed";
    const obs = emptyObservation();
    obs.failedTasks = [task];

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.retriedTasks).toHaveLength(0);
    expect(queue.get(failedTask.id)!.status).toBe("failed");
  });

  test("returns empty results when nothing to do", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks).toHaveLength(0);
    expect(result.retriedTasks).toHaveLength(0);
  });

  test("reactivates failed mission when retrying its tasks", async () => {
    const missionsPath = tmpPath("missions");
    const { createMission, failMission, loadMissions } = await import("../mission");
    const mission = await createMission("test-mission", {}, missionsPath);
    await failMission(mission.id, missionsPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const failedTask = createTask("Failed task");
    failedTask.missionId = mission.id;
    queue.enqueue(failedTask);
    const task = queue.get(failedTask.id)!;
    task.status = "failed";
    task.logs = [];

    const obs = emptyObservation();
    obs.failedTasks = [task];
    obs.failedMissions = [{ ...mission, status: "failed" as const }];

    await generateTasksFromObservation(queue, obs, { missionsPath });

    const missions = await loadMissions(missionsPath);
    expect(missions[0].status).toBe("active");
  });

  test("distills resolved feedback into agent template rules", async () => {
    const feedbackPath = tmpPath("feedback");
    const templatePath = join(tmpdir(), `worqload-iterate-template-${crypto.randomUUID()}.md`);
    await Bun.write(templatePath, "# Agent\n\n## Rules\n- Existing rule\n");
    await addFeedback("Always run tests before commit", "user", feedbackPath);
    const items = await loadFeedback(feedbackPath);
    await resolveFeedback(items[0].id, feedbackPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary.counts.resolved = 1;

    const result = await generateTasksFromObservation(queue, obs, { feedbackPath, templatePath });

    expect(result.distilledRules).toHaveLength(1);
    expect(result.distilledRules[0]).toBe("Always run tests before commit");
    const template = await Bun.file(templatePath).text();
    expect(template).toContain("- Always run tests before commit");
    const remainingFeedback = await loadFeedback(feedbackPath);
    expect(remainingFeedback).toHaveLength(0);
  });

  test("does not distill when no resolved feedback", async () => {
    const feedbackPath = tmpPath("feedback");
    const templatePath = join(tmpdir(), `worqload-iterate-template-${crypto.randomUUID()}.md`);
    await Bun.write(templatePath, "# Agent\n\n## Rules\n- Existing rule\n");
    await addFeedback("Unresolved feedback", "user", feedbackPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary.counts.resolved = 0;

    const result = await generateTasksFromObservation(queue, obs, { feedbackPath, templatePath });

    expect(result.distilledRules).toHaveLength(0);
    const remaining = await loadFeedback(feedbackPath);
    expect(remaining).toHaveLength(1);
  });

  test("does not distill when templatePath is not provided", async () => {
    const feedbackPath = tmpPath("feedback");
    await addFeedback("Resolved msg", "user", feedbackPath);
    const items = await loadFeedback(feedbackPath);
    await resolveFeedback(items[0].id, feedbackPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary.counts.resolved = 1;

    const result = await generateTasksFromObservation(queue, obs, { feedbackPath });

    expect(result.distilledRules).toHaveLength(0);
    const remaining = await loadFeedback(feedbackPath);
    expect(remaining).toHaveLength(1);
  });
});
