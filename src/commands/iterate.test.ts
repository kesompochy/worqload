import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { createTask, SHORT_ID_LENGTH, HUMAN_REQUIRED_PREFIX } from "../task";
import { addFeedback, resolveFeedback, loadFeedback, loadDistilledRules } from "../feedback";
import { addReport } from "../reports";
import { createMission, completeMission, failMission, loadMissions, loadMissionArchive } from "../mission";
import {
  collectObservation,
  analyzeObservation,
  formatObserveLog,
  auditRecentCompletions,
  generateTasksFromObservation,
  deriveAutonomousTasks,
  detectStuckTasks,
  recoverStuckTasks,
  filterManagedPaths,
  hasHumanAnswer,
  performActCleanup,
  formatCleanupLog,
  detectCompletedFeedbackTasks,
  needsHumanReport,
  ackFeedbackIds,
  iterate,
  type IterateContext,
  type IterateOptions,
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

  test("detects answered waiting_human tasks via non-HUMAN_REQUIRED orient log", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Awaiting answer");
    queue.enqueue(t1);
    queue.transition(t1.id, "orienting");
    queue.transition(t1.id, "waiting_human");
    queue.addLog(t1.id, "orient", `${HUMAN_REQUIRED_PREFIX}What should we do?`);
    queue.addLog(t1.id, "orient", "Approved by PM");
    const ctx = makeContext();

    const obs = await collectObservation(queue, ctx);

    expect(obs.waitingHumanTasks).toHaveLength(0);
    expect(obs.answeredHumanTasks).toHaveLength(1);
    expect(obs.answeredHumanTasks[0].id).toBe(t1.id);
  });

  test("does not mark waiting_human task as answered when only HUMAN_REQUIRED log exists", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Unanswered");
    queue.enqueue(t1);
    queue.transition(t1.id, "orienting");
    queue.transition(t1.id, "waiting_human");
    queue.addLog(t1.id, "orient", `${HUMAN_REQUIRED_PREFIX}Need help`);
    const ctx = makeContext();

    const obs = await collectObservation(queue, ctx);

    expect(obs.waitingHumanTasks).toHaveLength(1);
    expect(obs.answeredHumanTasks).toHaveLength(0);
  });

  test("does not mark waiting_human task as answered when no orient logs exist", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("No decide logs");
    queue.enqueue(t1);
    queue.transition(t1.id, "orienting");
    queue.transition(t1.id, "waiting_human");
    const ctx = makeContext();

    const obs = await collectObservation(queue, ctx);

    expect(obs.waitingHumanTasks).toHaveLength(1);
    expect(obs.answeredHumanTasks).toHaveLength(0);
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
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [],
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
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [],
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

describe("detectStuckTasks", () => {
  function backdateTask(queue: TaskQueue, taskId: string, minutesAgo: number): void {
    const past = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
    queue.get(taskId)!.updatedAt = past;
  }

  test("detects task stuck in orienting status beyond threshold", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Stuck orienting");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    backdateTask(queue, task.id, 40);

    const stuck = detectStuckTasks(queue.list(), 30);

    expect(stuck).toHaveLength(1);
    expect(stuck[0].taskId).toBe(task.id);
    expect(stuck[0].status).toBe("orienting");
    expect(stuck[0].stuckMinutes).toBeGreaterThanOrEqual(40);
  });

  test("detects task stuck in acting status", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Stuck acting");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "deciding");
    queue.transition(task.id, "acting");
    backdateTask(queue, task.id, 60);

    const stuck = detectStuckTasks(queue.list(), 30);

    expect(stuck).toHaveLength(1);
    expect(stuck[0].status).toBe("acting");
  });

  test("does not flag tasks within threshold", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Recent task");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");

    const stuck = detectStuckTasks(queue.list(), 30);

    expect(stuck).toHaveLength(0);
  });

  test("does not flag observing tasks (they are queued, not stuck)", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Queued task");
    queue.enqueue(task);
    backdateTask(queue, task.id, 40);

    const stuck = detectStuckTasks(queue.list(), 30);

    expect(stuck).toHaveLength(0);
  });

  test("does not flag done or failed tasks", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const doneTask = createTask("Done task");
    queue.enqueue(doneTask);
    queue.transition(doneTask.id, "orienting");
    queue.transition(doneTask.id, "deciding");
    queue.transition(doneTask.id, "acting");
    queue.transition(doneTask.id, "done");
    backdateTask(queue, doneTask.id, 40);

    const stuck = detectStuckTasks(queue.list(), 30);

    expect(stuck).toHaveLength(0);
  });

  test("detects multiple stuck tasks", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task1 = createTask("Stuck 1");
    const task2 = createTask("Stuck 2");
    queue.enqueue(task1);
    queue.enqueue(task2);
    queue.transition(task1.id, "orienting");
    queue.transition(task2.id, "orienting");
    queue.transition(task2.id, "deciding");
    backdateTask(queue, task1.id, 40);
    backdateTask(queue, task2.id, 40);

    const stuck = detectStuckTasks(queue.list(), 30);

    expect(stuck).toHaveLength(2);
  });
});

describe("recoverStuckTasks", () => {
  function backdateTask(queue: TaskQueue, taskId: string, minutesAgo: number): void {
    const past = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
    queue.get(taskId)!.updatedAt = past;
  }

  test("recovers stuck task by transitioning to failed then observing", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Stuck orienting");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    backdateTask(queue, task.id, 40);

    const stuckTasks = detectStuckTasks(queue.list(), 30);
    const result = recoverStuckTasks(queue, stuckTasks);

    expect(result.recoveredTasks).toContain(task.id);
    const recovered = queue.get(task.id)!;
    expect(recovered.status).toBe("observing");
    expect(recovered.owner).toBeUndefined();
    expect(recovered.logs.some(l => l.content.includes("[STUCK]"))).toBe(true);
  });

  test("clears owner on recovery", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Stuck with owner");
    queue.enqueue(task);
    queue.claim(task.id, "claude -p");
    queue.transition(task.id, "orienting");
    backdateTask(queue, task.id, 40);

    const stuckTasks = detectStuckTasks(queue.list(), 30);
    recoverStuckTasks(queue, stuckTasks);

    const recovered = queue.get(task.id)!;
    expect(recovered.owner).toBeUndefined();
  });

  test("marks as permanently failed when act logs exceed retry limit", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Stuck many retries");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    // Simulate previous act logs from retries
    queue.addLog(task.id, "act", "[STUCK] recovered previously");
    queue.addLog(task.id, "act", "[STUCK] recovered again");
    queue.addLog(task.id, "act", "some work done");
    backdateTask(queue, task.id, 40);

    const stuckTasks = detectStuckTasks(queue.list(), 30);
    const result = recoverStuckTasks(queue, stuckTasks);

    expect(result.permanentlyFailed).toContain(task.id);
    expect(result.recoveredTasks).not.toContain(task.id);
    expect(queue.get(task.id)!.status).toBe("failed");
  });

  test("recovers multiple stuck tasks", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task1 = createTask("Stuck 1");
    const task2 = createTask("Stuck 2");
    queue.enqueue(task1);
    queue.enqueue(task2);
    queue.transition(task1.id, "orienting");
    queue.transition(task2.id, "orienting");
    queue.transition(task2.id, "deciding");
    backdateTask(queue, task1.id, 40);
    backdateTask(queue, task2.id, 40);

    const stuckTasks = detectStuckTasks(queue.list(), 30);
    const result = recoverStuckTasks(queue, stuckTasks);

    expect(result.recoveredTasks).toHaveLength(2);
    expect(queue.get(task1.id)!.status).toBe("observing");
    expect(queue.get(task2.id)!.status).toBe("observing");
  });

  test("returns empty when no stuck tasks", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const result = recoverStuckTasks(queue, []);

    expect(result.recoveredTasks).toHaveLength(0);
    expect(result.permanentlyFailed).toHaveLength(0);
  });
});

describe("analyzeObservation - stuck tasks", () => {
  test("includes stuck tasks in analysis output", () => {
    const obs: Observation = {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [{ taskId: "abc12345-xxxx", title: "Stuck task", status: "acting", stuckMinutes: 45 }],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
    };

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("stuck");
    expect(analysis).toContain("Stuck task");
    expect(analysis).toContain("acting");
    expect(analysis).toContain("45m");
  });
});

describe("formatObserveLog - stuck tasks", () => {
  test("includes stuck task count in observe log", () => {
    const obs: Observation = {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [{ taskId: "abc12345", title: "Stuck", status: "orienting", stuckMinutes: 35 }],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
    };

    const log = formatObserveLog(obs);

    expect(log).toContain("stuck: 1");
  });

  test("shows stuck: 0 when no stuck tasks", () => {
    const obs: Observation = {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
    };

    const log = formatObserveLog(obs);

    expect(log).toContain("stuck: 0");
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
    await addReport("Report", `Completed task ${t1.id.slice(0, SHORT_ID_LENGTH)}: 認証ミドルウェアにJWTトークン検証を追加し、全テストを通過しました。`, "agent", reportsPath);
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

  test("flags report with vacuous content", async () => {
    const reportsPath = tmpPath("reports");
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Vacuous report task");
    queue.enqueue(t1);
    queue.addLog(t1.id, "act", "Implemented the full feature correctly");
    queue.transition(t1.id, "done");
    await addReport("Report", `（ログなし） ${t1.id.slice(0, SHORT_ID_LENGTH)}`, "agent", reportsPath);
    const ctx = makeContext({ reportsPath });

    const suspicious = await auditRecentCompletions(queue, ctx);

    expect(suspicious).toHaveLength(1);
    expect(suspicious[0].reasons).toContain("report lacks substance");
  });

  test("flags report with too-short content", async () => {
    const reportsPath = tmpPath("reports");
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Short report task");
    queue.enqueue(t1);
    queue.addLog(t1.id, "act", "Implemented the full feature correctly");
    queue.transition(t1.id, "done");
    await addReport("Report", `done ${t1.id.slice(0, SHORT_ID_LENGTH)}`, "agent", reportsPath);
    const ctx = makeContext({ reportsPath });

    const suspicious = await auditRecentCompletions(queue, ctx);

    expect(suspicious).toHaveLength(1);
    expect(suspicious[0].reasons).toContain("report lacks substance");
  });

  test("does not flag report with substantive content", async () => {
    const reportsPath = tmpPath("reports");
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Good report task");
    queue.enqueue(t1);
    queue.addLog(t1.id, "act", "Implemented the full feature correctly");
    queue.transition(t1.id, "done");
    await addReport("Report", `タスク ${t1.id.slice(0, SHORT_ID_LENGTH)} を完了しました。認証ミドルウェアにJWTトークン検証を追加し、テストを通過しました。`, "agent", reportsPath);
    const ctx = makeContext({ reportsPath });

    const suspicious = await auditRecentCompletions(queue, ctx);

    expect(suspicious).toEqual([]);
  });
});

describe("hasHumanAnswer", () => {
  test("returns true when orient answer log exists after HUMAN_REQUIRED log", () => {
    const task = createTask("Waiting task");
    task.status = "waiting_human";
    task.logs = [
      { phase: "orient", content: `${HUMAN_REQUIRED_PREFIX}Should we proceed?`, timestamp: new Date().toISOString() },
      { phase: "orient", content: "Yes, go ahead", timestamp: new Date().toISOString() },
    ];

    expect(hasHumanAnswer(task)).toBe(true);
  });

  test("returns false when no answer log after HUMAN_REQUIRED log", () => {
    const task = createTask("Waiting task");
    task.status = "waiting_human";
    task.logs = [
      { phase: "orient", content: `${HUMAN_REQUIRED_PREFIX}Should we proceed?`, timestamp: new Date().toISOString() },
    ];

    expect(hasHumanAnswer(task)).toBe(false);
  });

  test("returns false when orient log also has HUMAN_REQUIRED prefix", () => {
    const task = createTask("Waiting task");
    task.status = "waiting_human";
    task.logs = [
      { phase: "orient", content: `${HUMAN_REQUIRED_PREFIX}First question`, timestamp: new Date().toISOString() },
      { phase: "orient", content: `${HUMAN_REQUIRED_PREFIX}Another question`, timestamp: new Date().toISOString() },
    ];

    expect(hasHumanAnswer(task)).toBe(false);
  });

  test("returns false when no HUMAN_REQUIRED log exists", () => {
    const task = createTask("Waiting task");
    task.status = "waiting_human";
    task.logs = [
      { phase: "orient", content: "some analysis", timestamp: new Date().toISOString() },
      { phase: "orient", content: "some decision", timestamp: new Date().toISOString() },
    ];

    expect(hasHumanAnswer(task)).toBe(false);
  });

  test("ignores decide phase logs — only orient phase counts as answer", () => {
    const task = createTask("Waiting task");
    task.status = "waiting_human";
    task.logs = [
      { phase: "orient", content: `${HUMAN_REQUIRED_PREFIX}Should we proceed?`, timestamp: new Date().toISOString() },
      { phase: "decide", content: "Yes, go ahead", timestamp: new Date().toISOString() },
    ];

    expect(hasHumanAnswer(task)).toBe(false);
  });

  test("uses the last HUMAN_REQUIRED log when multiple exist", () => {
    const task = createTask("Waiting task");
    task.status = "waiting_human";
    task.logs = [
      { phase: "orient", content: `${HUMAN_REQUIRED_PREFIX}First question`, timestamp: new Date().toISOString() },
      { phase: "orient", content: "Answer to first", timestamp: new Date().toISOString() },
      { phase: "orient", content: `${HUMAN_REQUIRED_PREFIX}Second question`, timestamp: new Date().toISOString() },
    ];

    expect(hasHumanAnswer(task)).toBe(false);
  });

  test("returns true when answer follows latest HUMAN_REQUIRED log", () => {
    const task = createTask("Waiting task");
    task.status = "waiting_human";
    task.logs = [
      { phase: "orient", content: `${HUMAN_REQUIRED_PREFIX}First question`, timestamp: new Date().toISOString() },
      { phase: "orient", content: "Answer to first", timestamp: new Date().toISOString() },
      { phase: "orient", content: `${HUMAN_REQUIRED_PREFIX}Second question`, timestamp: new Date().toISOString() },
      { phase: "orient", content: "Answer to second", timestamp: new Date().toISOString() },
    ];

    expect(hasHumanAnswer(task)).toBe(true);
  });
});

describe("collectObservation - answered waiting_human", () => {
  test("separates answered waiting_human tasks", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const answered = createTask("Answered question");
    queue.enqueue(answered);
    queue.transition(answered.id, "orienting");
    queue.transition(answered.id, "waiting_human");
    queue.addLog(answered.id, "orient", `${HUMAN_REQUIRED_PREFIX}What to do?`);
    queue.addLog(answered.id, "orient", "Do this");

    const unanswered = createTask("Unanswered question");
    queue.enqueue(unanswered);
    queue.transition(unanswered.id, "orienting");
    queue.transition(unanswered.id, "waiting_human");
    queue.addLog(unanswered.id, "orient", `${HUMAN_REQUIRED_PREFIX}What now?`);

    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);

    expect(obs.answeredHumanTasks).toHaveLength(1);
    expect(obs.answeredHumanTasks[0].id).toBe(answered.id);
    expect(obs.waitingHumanTasks).toHaveLength(1);
    expect(obs.waitingHumanTasks[0].id).toBe(unanswered.id);
  });

  test("includes answered count in observe log", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Answered");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "waiting_human");
    queue.addLog(task.id, "orient", `${HUMAN_REQUIRED_PREFIX}Question?`);
    queue.addLog(task.id, "orient", "Answer from human");

    const ctx = makeContext();
    const obs = await collectObservation(queue, ctx);
    const log = formatObserveLog(obs);

    expect(log).toContain("1 answered");
  });
});

describe("analyzeObservation - answered waiting_human", () => {
  test("reports answered_human tag when answered tasks exist", () => {
    const obs: Observation = {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [createTask("Answered task")],
      suspiciousTasks: [],
      stuckTasks: [],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
    };

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("answered_human");
  });
});

describe("analyzeObservation - deciding tasks", () => {
  function emptyObs(): Observation {
    return {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
    };
  }

  test("reports deciding tasks individually in analysis output", () => {
    const decidingTask = createTask("Need to choose action");
    decidingTask.status = "deciding";
    const obs = emptyObs();
    obs.tasks = [decidingTask];

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("deciding");
    expect(analysis).toContain(decidingTask.id.slice(0, SHORT_ID_LENGTH));
    expect(analysis).toContain("Need to choose action");
  });

  test("reports multiple deciding tasks", () => {
    const d1 = createTask("Task A deciding");
    d1.status = "deciding";
    const d2 = createTask("Task B deciding");
    d2.status = "deciding";
    const obs = emptyObs();
    obs.tasks = [d1, d2];

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain(d1.id.slice(0, SHORT_ID_LENGTH));
    expect(analysis).toContain(d2.id.slice(0, SHORT_ID_LENGTH));
  });

  test("does not report deciding tag when no deciding tasks exist", () => {
    const observingTask = createTask("Regular task");
    const obs = emptyObs();
    obs.tasks = [observingTask];

    const analysis = analyzeObservation(obs);

    expect(analysis).not.toContain("has_deciding");
  });
});

describe("filterManagedPaths", () => {
  test("removes .worqload/ paths from git status output", () => {
    const gitStatus = " M src/foo.ts\n M .worqload/tasks.json\n?? src/bar.ts";

    const filtered = filterManagedPaths(gitStatus);

    expect(filtered).toBe(" M src/foo.ts\n?? src/bar.ts");
  });

  test("returns empty string when all changes are managed paths", () => {
    const gitStatus = " M .worqload/tasks.json\n M .worqload/archive.json";

    const filtered = filterManagedPaths(gitStatus);

    expect(filtered).toBe("");
  });

  test("returns original output when no managed paths present", () => {
    const gitStatus = " M src/foo.ts\n?? README.md";

    const filtered = filterManagedPaths(gitStatus);

    expect(filtered).toBe(" M src/foo.ts\n?? README.md");
  });

  test("returns empty string for empty input", () => {
    expect(filterManagedPaths("")).toBe("");
  });

  test("uses store path directory when provided", () => {
    const gitStatus = " M src/foo.ts\n M data/tasks.json\n?? data/archive.json";

    const filtered = filterManagedPaths(gitStatus, "data/tasks.json");

    expect(filtered).toBe(" M src/foo.ts");
  });

  test("does not filter paths that merely start with similar prefix", () => {
    const gitStatus = " M .worqload-extra/config.json\n M .worqload/tasks.json";

    const filtered = filterManagedPaths(gitStatus);

    expect(filtered).toBe(" M .worqload-extra/config.json");
  });
});

describe("generateTasksFromObservation", () => {
  function emptyObservation(): Observation {
    return {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [],
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

  test("does not create commit task when only managed paths have changes", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.uncommittedChanges = "";

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks.filter(t => t.includes("Commit"))).toHaveLength(0);
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
      themes: [{ description: "alice から未解決フィードバックが 3 件", feedbackIds: ["f1", "f2", "f3"] }],
      unresolvedIds: ["f1", "f2", "f3"],
    };

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks.some(t => t.includes("feedback"))).toBe(true);
    const feedbackTasks = queue.list().filter(t => t.title.includes("feedback"));
    expect(feedbackTasks.length).toBeGreaterThanOrEqual(1);
  });

  test("attaches feedbackIds to context when creating feedback theme task", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary = {
      counts: { new: 3, acknowledged: 0, resolved: 0 },
      recentUnresolved: [
        { id: "f1", from: "alice", message: "Fix bug", status: "new", createdAt: new Date().toISOString() },
        { id: "f2", from: "alice", message: "Still broken", status: "new", createdAt: new Date().toISOString() },
        { id: "f3", from: "alice", message: "Page error", status: "new", createdAt: new Date().toISOString() },
      ],
      themes: [{ description: "alice から未解決フィードバックが 3 件", feedbackIds: ["f1", "f2", "f3"] }],
      unresolvedIds: ["f1", "f2", "f3"],
    };

    await generateTasksFromObservation(queue, obs);

    const feedbackTask = queue.list().find(t => t.title.startsWith("Review feedback:"));
    expect(feedbackTask).toBeDefined();
    expect(feedbackTask!.context.feedbackIds).toEqual(["f1", "f2", "f3"]);
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
      themes: [{ description: "alice から未解決フィードバックが 3 件", feedbackIds: ["f1", "f2", "f3"] }],
      unresolvedIds: ["f1", "f2", "f3"],
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
      themes: [{ description: "alice から未解決フィードバックが 3 件", feedbackIds: ["f1", "f2", "f3"] }],
      unresolvedIds: ["f1", "f2", "f3"],
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

  test("does not recreate commit task when archived version exists", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const commitTask = createTask("Commit uncommitted changes");
    queue.enqueue(commitTask);
    queue.transition(commitTask.id, "done");
    await queue.archive([commitTask.id]);

    const obs = emptyObservation();
    obs.uncommittedChanges = " M src/foo.ts";

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks.filter(t => t.includes("Commit"))).toHaveLength(0);
  });

  test("does not recreate feedback task when archived version exists", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const feedbackTask = createTask("Review feedback: alice から未解決フィードバックが 3 件");
    queue.enqueue(feedbackTask);
    queue.transition(feedbackTask.id, "done");
    await queue.archive([feedbackTask.id]);

    const obs = emptyObservation();
    obs.feedbackSummary = {
      counts: { new: 3, acknowledged: 0, resolved: 0 },
      recentUnresolved: [],
      themes: [{ description: "alice から未解決フィードバックが 3 件", feedbackIds: ["f1", "f2", "f3"] }],
      unresolvedIds: ["f1", "f2", "f3"],
    };

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks.filter(t => t.includes("feedback"))).toHaveLength(0);
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

  test("transitions answered waiting_human tasks to orienting", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Needs approval");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "waiting_human");
    queue.addLog(task.id, "orient", `${HUMAN_REQUIRED_PREFIX}Should we proceed?`);
    queue.addLog(task.id, "orient", "Yes, proceed with the plan");

    const obs = emptyObservation();
    obs.answeredHumanTasks = [queue.get(task.id)!];

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.resumedTasks).toHaveLength(1);
    expect(result.resumedTasks[0]).toBe(task.id);
    expect(queue.get(task.id)!.status).toBe("orienting");
  });

  test("does not transition waiting_human tasks without human answer", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Still waiting");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "waiting_human");
    queue.addLog(task.id, "orient", `${HUMAN_REQUIRED_PREFIX}What should we do?`);

    const obs = emptyObservation();
    obs.answeredHumanTasks = [];

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.resumedTasks).toHaveLength(0);
    expect(queue.get(task.id)!.status).toBe("waiting_human");
  });

  test("derives feedback review task when queue is empty and unresolved directive-only feedback exists", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.principles = "# Principles\n\n- Improve quality continuously";
    obs.feedbackSummary = {
      counts: { new: 2, acknowledged: 1, resolved: 0 },
      recentUnresolved: [
        { id: "f1", from: "user", message: "Always run tests before deploy", status: "new", createdAt: new Date().toISOString() },
        { id: "f2", from: "user", message: "Never skip code review", status: "new", createdAt: new Date().toISOString() },
      ],
      themes: [],
      unresolvedIds: ["f1", "f2", "f3"],
    };

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.autonomousTasks.length).toBeGreaterThanOrEqual(3);
    expect(result.autonomousTasks.some(t => t.includes("feedback"))).toBe(true);
    const feedbackTasks = queue.list().filter(t => t.title.toLowerCase().includes("feedback"));
    expect(feedbackTasks).toHaveLength(3);
    const feedbackIds = feedbackTasks.map(t => t.context.feedbackId);
    expect(feedbackIds).toContain("f1");
    expect(feedbackIds).toContain("f2");
    expect(feedbackIds).toContain("f3");
  });

  test("derives improvement task from principles and source results when queue is empty", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.principles = "# Principles\n\n- Increase test coverage\n- Improve performance";
    obs.sourceResults = [
      { name: "test-coverage", output: "Coverage: 65%", exitCode: 0 },
    ];

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.autonomousTasks.length).toBeGreaterThanOrEqual(1);
    expect(queue.list().length).toBeGreaterThanOrEqual(1);
  });

  test("does not derive autonomous tasks when queue has active tasks", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const existing = createTask("Active task");
    queue.enqueue(existing);
    const obs = emptyObservation();
    obs.tasks = [existing];
    obs.principles = "# Principles\n\n- Increase test coverage";

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.autonomousTasks).toHaveLength(0);
  });

  test("does not derive autonomous tasks when waiting_human tasks exist", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const waiting = createTask("Waiting for input");
    waiting.status = "waiting_human";
    const obs = emptyObservation();
    obs.waitingHumanTasks = [waiting];
    obs.principles = "# Principles\n\n- Increase test coverage";

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.autonomousTasks).toHaveLength(0);
  });

  test("does not derive autonomous tasks when no principles exist", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.principles = "";

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.autonomousTasks).toHaveLength(0);
  });

  test("does not duplicate autonomous tasks already in queue or archive", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.principles = "# Principles\n\n- Increase test coverage";
    obs.sourceResults = [
      { name: "test-coverage", output: "Coverage: 65%", exitCode: 0 },
    ];

    // First call creates the task
    const result1 = await generateTasksFromObservation(queue, obs);
    expect(result1.autonomousTasks.length).toBeGreaterThanOrEqual(1);

    // Update obs.tasks to reflect the newly created tasks
    obs.tasks = queue.list();

    // Second call should not duplicate
    const result2 = await generateTasksFromObservation(queue, obs);
    expect(result2.autonomousTasks).toHaveLength(0);
  });

  test("returns autonomousTasks as empty array when nothing to derive", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.principles = "";

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.autonomousTasks).toEqual([]);
  });

  test("creates investigation task from observational (non-directive) feedback", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary = {
      counts: { new: 1, acknowledged: 0, resolved: 0 },
      recentUnresolved: [
        { id: "f1", from: "user", message: "報告書出てこない", status: "new", createdAt: new Date().toISOString() },
      ],
      themes: [],
      unresolvedIds: ["f1"],
    };

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks.some(t => t.includes("Investigate"))).toBe(true);
    const task = queue.list().find(t => t.title.startsWith("Investigate feedback:"));
    expect(task).toBeDefined();
    expect(task!.context.feedbackIds).toEqual(["f1"]);
    expect(task!.context.observations).toEqual(["報告書出てこない"]);
  });

  test("does not create investigation task from directive feedback", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary = {
      counts: { new: 1, acknowledged: 0, resolved: 0 },
      recentUnresolved: [
        { id: "f1", from: "user", message: "Always run tests before commit", status: "new", createdAt: new Date().toISOString() },
      ],
      themes: [],
      unresolvedIds: ["f1"],
    };

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks.filter(t => t.includes("Investigate"))).toHaveLength(0);
  });

  test("does not create investigation task from question feedback", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary = {
      counts: { new: 1, acknowledged: 0, resolved: 0 },
      recentUnresolved: [
        { id: "f1", from: "user", message: "これはバグですか？", status: "new", createdAt: new Date().toISOString() },
      ],
      themes: [],
      unresolvedIds: ["f1"],
    };

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.createdTasks.filter(t => t.includes("Investigate"))).toHaveLength(0);
  });

  test("does not duplicate investigation tasks", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary = {
      counts: { new: 1, acknowledged: 0, resolved: 0 },
      recentUnresolved: [
        { id: "f1", from: "user", message: "報告書出てこない", status: "new", createdAt: new Date().toISOString() },
      ],
      themes: [],
      unresolvedIds: ["f1"],
    };

    await generateTasksFromObservation(queue, obs);
    obs.tasks = queue.list();

    const result2 = await generateTasksFromObservation(queue, obs);

    expect(result2.createdTasks.filter(t => t.includes("Investigate"))).toHaveLength(0);
    expect(queue.list().filter(t => t.title.startsWith("Investigate feedback:"))).toHaveLength(1);
  });

  test("extracts only observational parts from mixed feedback", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary = {
      counts: { new: 1, acknowledged: 0, resolved: 0 },
      recentUnresolved: [
        { id: "f1", from: "user", message: "ビルドが遅い。テストを先に書くべき", status: "new", createdAt: new Date().toISOString() },
      ],
      themes: [],
      unresolvedIds: ["f1"],
    };

    const result = await generateTasksFromObservation(queue, obs);

    const task = queue.list().find(t => t.title.startsWith("Investigate feedback:"));
    expect(task).toBeDefined();
    expect(task!.context.observations).toEqual(["ビルドが遅い"]);
  });

  test("creates implementation tasks for unverified distilled rules", async () => {
    const feedbackPath = tmpPath("feedback");
    const templatePath = join(tmpdir(), `worqload-iterate-template-${crypto.randomUUID()}.md`);
    const distilledRulesPath = tmpPath("distilled-rules");
    await Bun.write(templatePath, "# Agent\n\n## Rules\n- Existing rule\n");
    await addFeedback("Always run tests before commit", "user", feedbackPath);
    const items = await loadFeedback(feedbackPath);
    await resolveFeedback(items[0].id, feedbackPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary.counts.resolved = 1;

    // First call: distills feedback and saves pending rules
    await generateTasksFromObservation(queue, obs, { feedbackPath, templatePath, distilledRulesPath });

    // Second call: no resolved feedback, but pending rules exist with no code changes
    const obs2 = emptyObservation();
    const result = await generateTasksFromObservation(queue, obs2, {
      feedbackPath,
      templatePath,
      distilledRulesPath,
      codeChangeChecker: async () => false,
    });

    expect(result.unverifiedRules).toHaveLength(1);
    expect(result.unverifiedRules[0]).toContain("Always run tests before commit");
    const implTask = queue.list().find(t => t.title.startsWith("Implement distilled rule:"));
    expect(implTask).toBeDefined();
    expect(implTask!.context.distilledRuleId).toBeDefined();
  });

  test("does not create implementation task when code changes verify the rule", async () => {
    const feedbackPath = tmpPath("feedback");
    const templatePath = join(tmpdir(), `worqload-iterate-template-${crypto.randomUUID()}.md`);
    const distilledRulesPath = tmpPath("distilled-rules");
    await Bun.write(templatePath, "# Agent\n\n## Rules\n- Existing rule\n");
    await addFeedback("Always run tests before commit", "user", feedbackPath);
    const items = await loadFeedback(feedbackPath);
    await resolveFeedback(items[0].id, feedbackPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary.counts.resolved = 1;

    await generateTasksFromObservation(queue, obs, { feedbackPath, templatePath, distilledRulesPath });

    // Code changes exist → rule should be verified, no task created
    const obs2 = emptyObservation();
    const result = await generateTasksFromObservation(queue, obs2, {
      feedbackPath,
      templatePath,
      distilledRulesPath,
      codeChangeChecker: async () => true,
    });

    expect(result.unverifiedRules).toHaveLength(0);
    const implTask = queue.list().find(t => t.title.startsWith("Implement distilled rule:"));
    expect(implTask).toBeUndefined();
  });

  test("does not create duplicate implementation tasks for already task_created rules", async () => {
    const feedbackPath = tmpPath("feedback");
    const templatePath = join(tmpdir(), `worqload-iterate-template-${crypto.randomUUID()}.md`);
    const distilledRulesPath = tmpPath("distilled-rules");
    await Bun.write(templatePath, "# Agent\n\n## Rules\n- Existing rule\n");
    await addFeedback("Always run tests before commit", "user", feedbackPath);
    const items = await loadFeedback(feedbackPath);
    await resolveFeedback(items[0].id, feedbackPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary.counts.resolved = 1;

    await generateTasksFromObservation(queue, obs, { feedbackPath, templatePath, distilledRulesPath });

    // First verify pass: creates task
    const obs2 = emptyObservation();
    await generateTasksFromObservation(queue, obs2, {
      feedbackPath,
      templatePath,
      distilledRulesPath,
      codeChangeChecker: async () => false,
    });

    // Second verify pass: should not create another task (rule is already task_created)
    const obs3 = emptyObservation();
    obs3.tasks = queue.list();
    const result = await generateTasksFromObservation(queue, obs3, {
      feedbackPath,
      templatePath,
      distilledRulesPath,
      codeChangeChecker: async () => false,
    });

    expect(result.unverifiedRules).toHaveLength(0);
    expect(queue.list().filter(t => t.title.startsWith("Implement distilled rule:"))).toHaveLength(1);
  });

  test("returns feedbackIdsToAck for theme tasks without acking", async () => {
    const feedbackPath = tmpPath("feedback");
    const fb1 = await addFeedback("Issue 1", "alice", feedbackPath);
    const fb2 = await addFeedback("Issue 2", "alice", feedbackPath);
    const fb3 = await addFeedback("Issue 3", "alice", feedbackPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary = {
      counts: { new: 3, acknowledged: 0, resolved: 0 },
      recentUnresolved: [],
      themes: [{ description: "alice から未解決フィードバックが 3 件", feedbackIds: [fb1.id, fb2.id, fb3.id] }],
      unresolvedIds: [fb1.id, fb2.id, fb3.id],
    };

    const result = await generateTasksFromObservation(queue, obs, { feedbackPath });

    expect(result.feedbackIdsToAck).toEqual(expect.arrayContaining([fb1.id, fb2.id, fb3.id]));
    const items = await loadFeedback(feedbackPath);
    for (const item of items) {
      expect(item.status).toBe("new");
    }
  });

  test("returns feedbackIdsToAck for observational feedback without acking", async () => {
    const feedbackPath = tmpPath("feedback");
    const fb = await addFeedback("報告書出てこない", "user", feedbackPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.feedbackSummary = {
      counts: { new: 1, acknowledged: 0, resolved: 0 },
      recentUnresolved: [
        { id: fb.id, from: "user", message: "報告書出てこない", status: "new", createdAt: new Date().toISOString() },
      ],
      themes: [],
      unresolvedIds: [fb.id],
    };

    const result = await generateTasksFromObservation(queue, obs, { feedbackPath });

    expect(result.feedbackIdsToAck).toContain(fb.id);
    const items = await loadFeedback(feedbackPath);
    expect(items[0].status).toBe("new");
  });

  test("returns feedbackIdsToAck for autonomous feedback review tasks without acking", async () => {
    const feedbackPath = tmpPath("feedback");
    const fb1 = await addFeedback("Always run tests", "user", feedbackPath);
    const fb2 = await addFeedback("Never skip review", "user", feedbackPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.principles = "# Principles\n\n- Improve quality";
    obs.feedbackSummary = {
      counts: { new: 2, acknowledged: 0, resolved: 0 },
      recentUnresolved: [
        { id: fb1.id, from: "user", message: "Always run tests", status: "new", createdAt: new Date().toISOString() },
        { id: fb2.id, from: "user", message: "Never skip review", status: "new", createdAt: new Date().toISOString() },
      ],
      themes: [],
      unresolvedIds: [fb1.id, fb2.id],
    };

    const result = await generateTasksFromObservation(queue, obs, { feedbackPath });

    expect(result.feedbackIdsToAck).toEqual(expect.arrayContaining([fb1.id, fb2.id]));
    const items = await loadFeedback(feedbackPath);
    for (const item of items) {
      expect(item.status).toBe("new");
    }
  });

  test("returns empty feedbackIdsToAck when no task is created (duplicate exists)", async () => {
    const feedbackPath = tmpPath("feedback");
    const fb = await addFeedback("報告書出てこない", "user", feedbackPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const existing = createTask("Investigate feedback: 報告書出てこない", { feedbackIds: [fb.id] });
    queue.enqueue(existing);

    const obs = emptyObservation();
    obs.feedbackSummary = {
      counts: { new: 1, acknowledged: 0, resolved: 0 },
      recentUnresolved: [
        { id: fb.id, from: "user", message: "報告書出てこない", status: "new", createdAt: new Date().toISOString() },
      ],
      themes: [],
      unresolvedIds: [fb.id],
    };
    obs.tasks = [existing];

    const result = await generateTasksFromObservation(queue, obs, { feedbackPath });

    expect(result.feedbackIdsToAck).toHaveLength(0);
    const items = await loadFeedback(feedbackPath);
    expect(items[0].status).toBe("new");
  });

  test("ackFeedbackIds acks feedback after being called separately", async () => {
    const feedbackPath = tmpPath("feedback");
    const fb1 = await addFeedback("Issue 1", "alice", feedbackPath);
    const fb2 = await addFeedback("Issue 2", "alice", feedbackPath);

    await ackFeedbackIds([fb1.id, fb2.id], feedbackPath);

    const items = await loadFeedback(feedbackPath);
    for (const item of items) {
      expect(item.status).toBe("acknowledged");
    }
  });

  test("recovers stuck tasks and reports them in result", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const stuckTask = createTask("Stuck acting task");
    queue.enqueue(stuckTask);
    queue.transition(stuckTask.id, "orienting");
    queue.transition(stuckTask.id, "deciding");
    queue.transition(stuckTask.id, "acting");
    const past = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    queue.get(stuckTask.id)!.updatedAt = past;

    const obs = emptyObservation();
    obs.stuckTasks = [{ taskId: stuckTask.id, title: stuckTask.title, status: "acting", stuckMinutes: 45 }];

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.recoveredTasks).toContain(stuckTask.id);
    expect(queue.get(stuckTask.id)!.status).toBe("observing");
  });
});

describe("deriveAutonomousTasks", () => {
  function emptyObs(): Observation {
    return {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
    };
  }

  test("derives test fix task when test results contain fail", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObs();
    obs.principles = "# Principles\n\n- Quality first";
    obs.sourceResults = [
      { name: "test results", output: "3 pass\n1 fail\nsome error", exitCode: 1 },
    ];

    const derived = deriveAutonomousTasks(obs, queue, []);

    expect(derived.some(t => t.title.toLowerCase().includes("test"))).toBe(true);
  });

  test("does not derive test fix task when tests all pass", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObs();
    obs.principles = "# Principles\n\n- Quality first";
    obs.sourceResults = [
      { name: "test results", output: "10 pass\n0 fail", exitCode: 0 },
    ];

    const derived = deriveAutonomousTasks(obs, queue, []);

    expect(derived.some(t => t.title.toLowerCase().includes("fix failing test"))).toBe(false);
  });

  test("derives investigation task when principles exist but sources have no actionable output", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObs();
    obs.principles = "# Principles\n\n- Improve documentation";
    obs.sourceResults = [
      { name: "git status", output: "", exitCode: 0 },
    ];

    const derived = deriveAutonomousTasks(obs, queue, []);

    expect(derived.length).toBe(1);
    expect(derived[0].title).toContain("Principles");
  });

  test("derives investigation task when principles exist and sources are empty", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObs();
    obs.principles = "# Principles\n\n- Ship small increments";

    const derived = deriveAutonomousTasks(obs, queue, []);

    expect(derived.length).toBe(1);
    expect(derived[0].title).toContain("Principles");
  });

  test("does not duplicate investigation task if one already exists", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const existing = createTask("Investigate improvements based on Principles");
    queue.enqueue(existing);
    const obs = emptyObs();
    obs.principles = "# Principles\n\n- Ship small increments";
    obs.tasks = [existing];

    const derived = deriveAutonomousTasks(obs, queue, []);

    expect(derived.filter(t => t.title.includes("Principles"))).toHaveLength(0);
  });

  test("prefers specific source-derived tasks over general investigation", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObs();
    obs.principles = "# Principles\n\n- Quality first";
    obs.sourceResults = [
      { name: "test results", output: "5 pass\n2 fail\nError in login.test", exitCode: 1 },
    ];

    const derived = deriveAutonomousTasks(obs, queue, []);

    // Should derive a test fix task, not a general investigation task
    expect(derived.some(t => t.title.toLowerCase().includes("test"))).toBe(true);
    expect(derived.filter(t => t.title.includes("Investigate improvements"))).toHaveLength(0);
  });

  test("derives investigation task even when same title exists in archive", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const archived = createTask("Investigate improvements based on Principles");
    archived.status = "done" as any;
    const obs = emptyObs();
    obs.principles = "# Principles\n\n- Improve documentation";

    const derived = deriveAutonomousTasks(obs, queue, [archived]);

    expect(derived.length).toBe(1);
    expect(derived[0].title).toContain("Principles");
  });

  test("still checks active queue for investigation task duplicates", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const active = createTask("Investigate improvements based on Principles");
    queue.enqueue(active);
    const obs = emptyObs();
    obs.principles = "# Principles\n\n- Improve documentation";
    obs.tasks = [active];

    const derived = deriveAutonomousTasks(obs, queue, []);

    expect(derived.filter(t => t.title.includes("Principles"))).toHaveLength(0);
  });

  test("returns empty array when no principles exist", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObs();
    obs.principles = "";

    const derived = deriveAutonomousTasks(obs, queue, []);

    expect(derived).toHaveLength(0);
  });

  test("investigation task includes parsedPrincipleItems in context.principles", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObs();
    obs.principles = "# Principles\n\n- Improve documentation\n- Ship small increments";

    const derived = deriveAutonomousTasks(obs, queue, []);

    expect(derived).toHaveLength(1);
    expect(derived[0].title).toContain("Principles");
    expect(derived[0].context.principles).toEqual(["Improve documentation", "Ship small increments"]);
  });

  test("derives one feedback review task per unresolved feedback id", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObs();
    obs.principles = "# Principles\n\n- Quality first";
    obs.feedbackSummary = {
      counts: { new: 3, acknowledged: 0, resolved: 0 },
      recentUnresolved: [],
      themes: [],
      unresolvedIds: ["fb-1", "fb-2", "fb-3"],
    };

    const derived = deriveAutonomousTasks(obs, queue, []);

    const feedbackTasks = derived.filter(t => t.title.includes("feedback"));
    expect(feedbackTasks).toHaveLength(3);
    expect(feedbackTasks[0].context.feedbackId).toBe("fb-1");
    expect(feedbackTasks[1].context.feedbackId).toBe("fb-2");
    expect(feedbackTasks[2].context.feedbackId).toBe("fb-3");
  });

  test("skips feedback review task when same feedback id already has a task in queue", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const existing = createTask("Review unresolved feedback [fb-1]");
    queue.enqueue(existing);
    const obs = emptyObs();
    obs.principles = "# Principles\n\n- Quality first";
    obs.tasks = [existing];
    obs.feedbackSummary = {
      counts: { new: 2, acknowledged: 0, resolved: 0 },
      recentUnresolved: [],
      themes: [],
      unresolvedIds: ["fb-1", "fb-2"],
    };

    const derived = deriveAutonomousTasks(obs, queue, []);

    const feedbackTasks = derived.filter(t => t.title.includes("feedback"));
    expect(feedbackTasks).toHaveLength(1);
    expect(feedbackTasks[0].context.feedbackId).toBe("fb-2");
  });

  test("skips feedback review task when same feedback id exists in archive", () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const archived = createTask("Review unresolved feedback [fb-1]");
    archived.status = "done" as any;
    const obs = emptyObs();
    obs.principles = "# Principles\n\n- Quality first";
    obs.feedbackSummary = {
      counts: { new: 2, acknowledged: 0, resolved: 0 },
      recentUnresolved: [],
      themes: [],
      unresolvedIds: ["fb-1", "fb-2"],
    };

    const derived = deriveAutonomousTasks(obs, queue, [archived]);

    const feedbackTasks = derived.filter(t => t.title.includes("feedback"));
    expect(feedbackTasks).toHaveLength(1);
    expect(feedbackTasks[0].context.feedbackId).toBe("fb-2");
  });
});

describe("performActCleanup", () => {
  test("archives done and failed tasks and returns count", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const doneTask = createTask("Done task");
    queue.enqueue(doneTask);
    queue.transition(doneTask.id, "done");
    const failedTask = createTask("Failed task");
    queue.enqueue(failedTask);
    failedTask.status = "failed" as any;
    queue.update(failedTask.id, { status: "failed" as any });
    const activeTask = createTask("Active task");
    queue.enqueue(activeTask);

    const result = await performActCleanup(queue, {});

    expect(result.archivedCount).toBe(2);
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0].title).toBe("Active task");
  });

  test("returns zero archived count when no done/failed tasks", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const activeTask = createTask("Active task");
    queue.enqueue(activeTask);

    const result = await performActCleanup(queue, {});

    expect(result.archivedCount).toBe(0);
    expect(queue.list()).toHaveLength(1);
  });

  test("detects unread reports and returns their titles", async () => {
    const reportsPath = tmpPath("reports");
    await addReport("Report A", "content a", "agent", reportsPath);
    await addReport("Report B", "content b", "agent", reportsPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const result = await performActCleanup(queue, { reportsPath });

    expect(result.unreadReports).toHaveLength(2);
    expect(result.unreadReports).toContain("Report A");
    expect(result.unreadReports).toContain("Report B");
  });

  test("excludes read reports from unread list", async () => {
    const reportsPath = tmpPath("reports");
    await addReport("Unread report", "content", "agent", reportsPath);
    const { updateReportStatus, loadReports: lr } = await import("../reports");
    const reports = await lr(reportsPath);
    await updateReportStatus(reports[0].id, "read", reportsPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const result = await performActCleanup(queue, { reportsPath });

    expect(result.unreadReports).toHaveLength(0);
  });

  test("returns empty unread reports when reportsPath is not set", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const result = await performActCleanup(queue, {});

    expect(result.unreadReports).toHaveLength(0);
  });

  test("handles both archiving and unread reports together", async () => {
    const reportsPath = tmpPath("reports");
    await addReport("New report", "content", "agent", reportsPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const doneTask = createTask("Done task");
    queue.enqueue(doneTask);
    queue.transition(doneTask.id, "done");

    const result = await performActCleanup(queue, { reportsPath });

    expect(result.archivedCount).toBe(1);
    expect(result.unreadReports).toHaveLength(1);
    expect(result.unreadReports[0]).toBe("New report");
  });

  test("does not archive observing or orienting tasks", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const observing = createTask("Observing task");
    queue.enqueue(observing);
    const orienting = createTask("Orienting task");
    queue.enqueue(orienting);
    queue.transition(orienting.id, "orienting");

    const result = await performActCleanup(queue, {});

    expect(result.archivedCount).toBe(0);
    expect(queue.list()).toHaveLength(2);
  });

  test("archives completed missions when missionsPath is set", async () => {
    const missionsPath = tmpPath("missions");
    const missionArchivePath = tmpPath("mission-archive");
    const m1 = await createMission("done-mission", {}, missionsPath);
    await completeMission(m1.id, missionsPath);
    await createMission("active-mission", {}, missionsPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const result = await performActCleanup(queue, { missionsPath, missionArchivePath });

    expect(result.archivedMissionCount).toBe(1);
    const remaining = await loadMissions(missionsPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("active-mission");
    const archived = await loadMissionArchive(missionArchivePath);
    expect(archived).toHaveLength(1);
    expect(archived[0].name).toBe("done-mission");
  });

  test("archives failed missions", async () => {
    const missionsPath = tmpPath("missions");
    const missionArchivePath = tmpPath("mission-archive");
    const m = await createMission("failed-mission", {}, missionsPath);
    await failMission(m.id, missionsPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const result = await performActCleanup(queue, { missionsPath, missionArchivePath });

    expect(result.archivedMissionCount).toBe(1);
    const archived = await loadMissionArchive(missionArchivePath);
    expect(archived[0].status).toBe("failed");
  });

  test("does not archive active missions", async () => {
    const missionsPath = tmpPath("missions");
    const missionArchivePath = tmpPath("mission-archive");
    await createMission("active-mission", {}, missionsPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const result = await performActCleanup(queue, { missionsPath, missionArchivePath });

    expect(result.archivedMissionCount).toBe(0);
    const remaining = await loadMissions(missionsPath);
    expect(remaining).toHaveLength(1);
  });

  test("returns zero archivedMissionCount when missionsPath is not set", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const result = await performActCleanup(queue, {});

    expect(result.archivedMissionCount).toBe(0);
  });
});

describe("formatCleanupLog", () => {
  test("returns empty string when nothing to report", () => {
    expect(formatCleanupLog({ archivedCount: 0, archivedMissionCount: 0, unreadReports: [] })).toBe("");
  });

  test("includes archived count when tasks were archived", () => {
    const result = formatCleanupLog({ archivedCount: 3, archivedMissionCount: 0, unreadReports: [] });
    expect(result).toBe("archived 3 task(s)");
  });

  test("includes unread report titles", () => {
    const result = formatCleanupLog({ archivedCount: 0, archivedMissionCount: 0, unreadReports: ["Report A", "Report B"] });
    expect(result).toBe("2 unread report(s): Report A, Report B");
  });

  test("combines archived count and unread reports", () => {
    const result = formatCleanupLog({ archivedCount: 2, archivedMissionCount: 0, unreadReports: ["Report X"] });
    expect(result).toBe("archived 2 task(s); 1 unread report(s): Report X");
  });

  test("includes archived mission count", () => {
    const result = formatCleanupLog({ archivedCount: 0, archivedMissionCount: 2, unreadReports: [] });
    expect(result).toBe("archived 2 mission(s)");
  });

  test("combines all cleanup results", () => {
    const result = formatCleanupLog({ archivedCount: 1, archivedMissionCount: 3, unreadReports: ["Report A"] });
    expect(result).toBe("archived 1 task(s); archived 3 mission(s); 1 unread report(s): Report A");
  });
});

describe("iterate - waiting_human suppresses chat output", () => {
  function waitingHumanObservation(waitingTasks: Task[]): Observation {
    return {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: waitingTasks,
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
    };
  }

  test("does not print individual questions to console when waiting_human tasks exist", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Blocked task");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "waiting_human");
    queue.addLog(task.id, "orient", `${HUMAN_REQUIRED_PREFIX}What should we do?`);

    const obs = waitingHumanObservation([queue.get(task.id)!]);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await iterate(queue, [], { observationOverride: obs });
    } finally {
      console.log = originalLog;
    }

    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("waiting_human");
    expect(logs[0]).not.toContain("What should we do?");
  });

  test("extracts question from orient-phase log, not decide-phase", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Orient blocked");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "waiting_human");
    queue.addLog(task.id, "orient", `${HUMAN_REQUIRED_PREFIX}What approach should we take?`);

    const obs = waitingHumanObservation([queue.get(task.id)!]);

    const originalLog = console.log;
    console.log = () => {};
    try {
      await iterate(queue, [], { observationOverride: obs });
    } finally {
      console.log = originalLog;
    }

    const allTasks = [...queue.list(), ...await queue.history()];
    const iterateTask = allTasks.find(t => t.title.startsWith("Iterate:"));
    expect(iterateTask).toBeDefined();
    const decideLog = iterateTask!.logs.find(l => l.phase === "decide");
    expect(decideLog).toBeDefined();
    expect(decideLog!.content).toContain("What approach should we take?");
    // Should NOT fall back to task title
    expect(decideLog!.content).not.toContain("Orient blocked");
  });

  test("logs dashboard reference instead of 'presented to user'", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Needs input");
    queue.enqueue(task);
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "waiting_human");
    queue.addLog(task.id, "orient", `${HUMAN_REQUIRED_PREFIX}Approve this?`);

    const obs = waitingHumanObservation([queue.get(task.id)!]);

    const originalLog = console.log;
    console.log = () => {};
    try {
      await iterate(queue, [], { observationOverride: obs });
    } finally {
      console.log = originalLog;
    }

    const allTasks = [...queue.list(), ...await queue.history()];
    const iterateTask = allTasks.find(t => t.title.startsWith("Iterate:"));
    expect(iterateTask).toBeDefined();
    const actLog = iterateTask!.logs.find(l => l.phase === "act");
    expect(actLog).toBeDefined();
    expect(actLog!.content).not.toContain("presented waiting_human questions to user");
    expect(actLog!.content).toContain("dashboard");
  });
});

describe("iterate - new feedback count in output", () => {
  function obsWithFeedback(newCount: number): Observation {
    return {
      feedbackSummary: { counts: { new: newCount, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
      completedFeedbackTasks: [],
    };
  }

  test("prints new feedback count when there are new feedback items", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = obsWithFeedback(3);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await iterate(queue, [], { observationOverride: obs });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some(l => l.includes("new feedback: 3"))).toBe(true);
  });

  test("does not print feedback line when new feedback count is 0", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = obsWithFeedback(0);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await iterate(queue, [], { observationOverride: obs });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some(l => l.includes("new feedback:"))).toBe(false);
  });

  test("prints new feedback count alongside has_pending output", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = obsWithFeedback(2);
    const task = createTask("Some task");
    queue.enqueue(task);
    obs.tasks = [task];

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await iterate(queue, [], { observationOverride: obs });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some(l => l.includes("new feedback: 2"))).toBe(true);
  });
});

describe("detectCompletedFeedbackTasks", () => {
  test("detects done task with context.feedbackIds and no human report", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Fix login bug", { feedbackIds: ["fb-1", "fb-2"] });
    queue.enqueue(task);
    queue.transition(task.id, "done");

    const result = await detectCompletedFeedbackTasks(queue, {});

    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe(task.id);
    expect(result[0].title).toBe("Fix login bug");
    expect(result[0].feedbackIds).toEqual(["fb-1", "fb-2"]);
  });

  test("detects done task with context.feedbackId (singular)", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Review feedback item", { feedbackId: "fb-99" });
    queue.enqueue(task);
    queue.transition(task.id, "done");

    const result = await detectCompletedFeedbackTasks(queue, {});

    expect(result).toHaveLength(1);
    expect(result[0].feedbackIds).toEqual(["fb-99"]);
  });

  test("ignores done task without feedback context", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Refactor module");
    queue.enqueue(task);
    queue.transition(task.id, "done");

    const result = await detectCompletedFeedbackTasks(queue, {});

    expect(result).toHaveLength(0);
  });

  test("ignores non-done feedback task", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Fix bug", { feedbackIds: ["fb-1"] });
    queue.enqueue(task);

    const result = await detectCompletedFeedbackTasks(queue, {});

    expect(result).toHaveLength(0);
  });

  test("ignores feedback task that already has a human-category report", async () => {
    const reportsPath = tmpPath("reports");
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Fix bug", { feedbackIds: ["fb-1"] });
    queue.enqueue(task);
    queue.transition(task.id, "done");

    await addReport("Fix bug report", "Bug was fixed by updating validation", "agent", { taskId: task.id, path: reportsPath, category: "human" });

    const result = await detectCompletedFeedbackTasks(queue, { reportsPath });

    expect(result).toHaveLength(0);
  });

  test("detects feedback task with only internal report (no human report)", async () => {
    const reportsPath = tmpPath("reports");
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Fix bug", { feedbackIds: ["fb-1"] });
    queue.enqueue(task);
    queue.transition(task.id, "done");

    await addReport("Fix bug report", "Internal implementation details", "mission:test", { taskId: task.id, path: reportsPath });

    const result = await detectCompletedFeedbackTasks(queue, { reportsPath });

    expect(result).toHaveLength(1);
  });

  test("excludes iterate task itself", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Fix bug", { feedbackIds: ["fb-1"] });
    queue.enqueue(task);
    queue.transition(task.id, "done");

    const result = await detectCompletedFeedbackTasks(queue, {}, task.id);

    expect(result).toHaveLength(0);
  });
});

describe("generateTasksFromObservation - human report tasks", () => {
  function emptyObservation(): Observation {
    return {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
      completedFeedbackTasks: [],
    };
  }

  test("creates human report task for completed feedback task", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.completedFeedbackTasks = [
      { taskId: "task-1", title: "Fix login bug", feedbackIds: ["fb-1", "fb-2"] },
    ];

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.humanReportTasks).toHaveLength(1);
    const reportTask = queue.list().find(t => t.title.includes("Report to human"));
    expect(reportTask).toBeDefined();
    expect(reportTask!.context.sourceTaskId).toBe("task-1");
    expect(reportTask!.context.sourceTaskTitle).toBe("Fix login bug");
    expect(reportTask!.context.feedbackIds).toEqual(["fb-1", "fb-2"]);
  });

  test("does not duplicate human report task", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const existing = createTask("Report to human: Fix login bug");
    queue.enqueue(existing);

    const obs = emptyObservation();
    obs.tasks = [existing];
    obs.completedFeedbackTasks = [
      { taskId: "task-1", title: "Fix login bug", feedbackIds: ["fb-1"] },
    ];

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.humanReportTasks).toHaveLength(0);
  });

  test("creates multiple report tasks for multiple completed feedback tasks", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.completedFeedbackTasks = [
      { taskId: "task-1", title: "Fix login bug", feedbackIds: ["fb-1"] },
      { taskId: "task-2", title: "Add dark mode", feedbackIds: ["fb-2"] },
    ];

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.humanReportTasks).toHaveLength(2);
  });
});

describe("analyzeObservation - report_human", () => {
  function emptyObservation(): Observation {
    return {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
      completedFeedbackTasks: [],
    };
  }

  test("includes report_human tag when completed feedback tasks exist", () => {
    const obs = emptyObservation();
    obs.completedFeedbackTasks = [
      { taskId: "task-1", title: "Fix login bug", feedbackIds: ["fb-1"] },
    ];

    const analysis = analyzeObservation(obs);

    expect(analysis).toContain("report_human");
    expect(analysis).toContain("Fix login bug");
  });

  test("does not include report_human tag when no completed feedback tasks", () => {
    const obs = emptyObservation();

    const analysis = analyzeObservation(obs);

    expect(analysis).not.toContain("report_human");
  });
});

describe("needsHumanReport", () => {
  test("returns true for task with feedbackIds in context", () => {
    const task = createTask("Fix login bug", { feedbackIds: ["fb-1"] });
    expect(needsHumanReport(task)).toBe(true);
  });

  test("returns true for task with singular feedbackId in context", () => {
    const task = createTask("Review item", { feedbackId: "fb-99" });
    expect(needsHumanReport(task)).toBe(true);
  });

  test("returns true for task that had human escalation", () => {
    const task = createTask("Investigate issue");
    task.logs.push({
      phase: "orient",
      content: `${HUMAN_REQUIRED_PREFIX}What should we prioritize?`,
      timestamp: new Date().toISOString(),
    });
    expect(needsHumanReport(task)).toBe(true);
  });

  test("returns false for report task itself", () => {
    const task = createTask("Report to human: Fix login bug", {
      sourceTaskId: "t-1",
      feedbackIds: ["fb-1"],
    });
    expect(needsHumanReport(task)).toBe(false);
  });

  test("returns false for regular task without feedback or escalation", () => {
    const task = createTask("Refactor module");
    expect(needsHumanReport(task)).toBe(false);
  });

  test("returns false for internal maintenance task", () => {
    const task = createTask("Commit uncommitted changes");
    expect(needsHumanReport(task)).toBe(false);
  });
});

describe("detectCompletedFeedbackTasks - escalated tasks", () => {
  test("detects done task that had human escalation", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Investigate issue");
    task.logs.push({
      phase: "orient",
      content: `${HUMAN_REQUIRED_PREFIX}What should we do?`,
      timestamp: new Date().toISOString(),
    });
    queue.enqueue(task);
    queue.transition(task.id, "done");

    const result = await detectCompletedFeedbackTasks(queue, {});

    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe(task.id);
    expect(result[0].title).toBe("Investigate issue");
    expect(result[0].feedbackIds).toEqual([]);
  });

  test("ignores done report task even if it had escalation", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Report to human: Fix bug", { sourceTaskId: "t-1" });
    task.logs.push({
      phase: "orient",
      content: `${HUMAN_REQUIRED_PREFIX}Need clarification`,
      timestamp: new Date().toISOString(),
    });
    queue.enqueue(task);
    queue.transition(task.id, "done");

    const result = await detectCompletedFeedbackTasks(queue, {});

    expect(result).toHaveLength(0);
  });

  test("ignores escalated task that already has a human report", async () => {
    const reportsPath = tmpPath("reports");
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const task = createTask("Investigate issue");
    task.logs.push({
      phase: "orient",
      content: `${HUMAN_REQUIRED_PREFIX}What priority?`,
      timestamp: new Date().toISOString(),
    });
    queue.enqueue(task);
    queue.transition(task.id, "done");

    await addReport("Investigation report", "Findings here", "agent", {
      taskId: task.id,
      path: reportsPath,
      category: "human",
    });

    const result = await detectCompletedFeedbackTasks(queue, { reportsPath });

    expect(result).toHaveLength(0);
  });
});

describe("generateTasksFromObservation - escalated task report", () => {
  function emptyObservation(): Observation {
    return {
      feedbackSummary: { counts: { new: 0, acknowledged: 0, resolved: 0 }, recentUnresolved: [], themes: [], unresolvedIds: [] },
      activeMissions: [],
      failedMissions: [],
      sourceResults: [],
      principles: "",
      tasks: [],
      waitingHumanTasks: [],
      answeredHumanTasks: [],
      suspiciousTasks: [],
      stuckTasks: [],
      failedTasks: [],
      uncommittedChanges: "",
      serverLogSummary: null,
      completedFeedbackTasks: [],
    };
  }

  test("creates report task for escalated (non-feedback) completed task", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const obs = emptyObservation();
    obs.completedFeedbackTasks = [
      { taskId: "task-esc", title: "Investigate issue", feedbackIds: [] },
    ];

    const result = await generateTasksFromObservation(queue, obs);

    expect(result.humanReportTasks).toHaveLength(1);
    const reportTask = queue.list().find(t => t.title.includes("Report to human"));
    expect(reportTask).toBeDefined();
    expect(reportTask!.context.sourceTaskId).toBe("task-esc");
  });
});
