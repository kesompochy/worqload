import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "./queue";
import { createTask } from "./task";
import { saveMissions, createMission } from "./mission";
import { addReport } from "./reports";
import { addFeedback } from "./feedback";
import { collectResumeState, formatResumeSummary } from "./resume";

function tmpPath(prefix: string): string {
  return join(tmpdir(), `worqload-resume-${prefix}-${crypto.randomUUID()}.json`);
}

describe("collectResumeState", () => {
  test("returns empty state when nothing exists", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();

    const state = await collectResumeState(queue, {
      missionsPath: tmpPath("missions"),
      reportsPath: tmpPath("reports"),
      feedbackPath: tmpPath("feedback"),
    });

    expect(state.pendingTasks).toEqual([]);
    expect(state.activeTasks).toEqual([]);
    expect(state.waitingHumanTasks).toEqual([]);
    expect(state.activeMissions).toEqual([]);
    expect(state.unreadReports).toEqual([]);
    expect(state.newFeedback).toEqual([]);
  });

  test("collects pending tasks", async () => {
    const storePath = tmpPath("tasks");
    const queue = new TaskQueue(storePath, tmpPath("archive"));
    queue.enqueue(createTask("Task A"));
    queue.enqueue(createTask("Task B"));
    await queue.save();

    const state = await collectResumeState(queue, {
      missionsPath: tmpPath("missions"),
      reportsPath: tmpPath("reports"),
      feedbackPath: tmpPath("feedback"),
    });

    expect(state.pendingTasks).toHaveLength(2);
  });

  test("collects active tasks (observing/orienting/deciding/acting)", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t1 = createTask("Observing task");
    const t2 = createTask("Acting task");
    queue.enqueue(t1);
    queue.enqueue(t2);
    queue.transition(t1.id, "observing");
    queue.transition(t2.id, "observing");
    queue.transition(t2.id, "orienting");
    queue.transition(t2.id, "deciding");
    queue.transition(t2.id, "acting");

    const state = await collectResumeState(queue, {
      missionsPath: tmpPath("missions"),
      reportsPath: tmpPath("reports"),
      feedbackPath: tmpPath("feedback"),
    });

    expect(state.activeTasks).toHaveLength(2);
  });

  test("collects waiting_human tasks", async () => {
    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    const t = createTask("Needs human");
    queue.enqueue(t);
    queue.transition(t.id, "observing");
    queue.transition(t.id, "orienting");
    queue.transition(t.id, "deciding");
    queue.transition(t.id, "waiting_human");

    const state = await collectResumeState(queue, {
      missionsPath: tmpPath("missions"),
      reportsPath: tmpPath("reports"),
      feedbackPath: tmpPath("feedback"),
    });

    expect(state.waitingHumanTasks).toHaveLength(1);
  });

  test("collects active missions only", async () => {
    const missionsPath = tmpPath("missions");
    await createMission("Active mission", {}, missionsPath);
    const m2 = await createMission("Completed mission", {}, missionsPath);
    const { loadMissions } = await import("./mission");
    const missions = await loadMissions(missionsPath);
    const completed = missions.find(m => m.id === m2.id)!;
    completed.status = "completed";
    await saveMissions(missions, missionsPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();

    const state = await collectResumeState(queue, {
      missionsPath,
      reportsPath: tmpPath("reports"),
      feedbackPath: tmpPath("feedback"),
    });

    expect(state.activeMissions).toHaveLength(1);
    expect(state.activeMissions[0].name).toBe("Active mission");
  });

  test("collects unread reports only", async () => {
    const reportsPath = tmpPath("reports");
    await addReport("Unread report", "content", "agent", reportsPath);
    const r2 = await addReport("Read report", "content", "agent", reportsPath);
    const { updateReportStatus } = await import("./reports");
    await updateReportStatus(r2.id, "read", reportsPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();

    const state = await collectResumeState(queue, {
      missionsPath: tmpPath("missions"),
      reportsPath,
      feedbackPath: tmpPath("feedback"),
    });

    expect(state.unreadReports).toHaveLength(1);
    expect(state.unreadReports[0].title).toBe("Unread report");
  });

  test("collects new feedback only", async () => {
    const feedbackPath = tmpPath("feedback");
    await addFeedback("New feedback", "user", feedbackPath);
    const f2 = await addFeedback("Acked feedback", "user", feedbackPath);
    const { acknowledgeFeedback } = await import("./feedback");
    await acknowledgeFeedback(f2.id, feedbackPath);

    const queue = new TaskQueue(tmpPath("tasks"), tmpPath("archive"));
    await queue.load();

    const state = await collectResumeState(queue, {
      missionsPath: tmpPath("missions"),
      reportsPath: tmpPath("reports"),
      feedbackPath,
    });

    expect(state.newFeedback).toHaveLength(1);
    expect(state.newFeedback[0].message).toBe("New feedback");
  });
});

describe("formatResumeSummary", () => {
  test("shows 'nothing to resume' when state is empty", () => {
    const summary = formatResumeSummary({
      pendingTasks: [],
      activeTasks: [],
      waitingHumanTasks: [],
      activeMissions: [],
      unreadReports: [],
      newFeedback: [],
    });

    expect(summary).toContain("Nothing to resume");
  });

  test("includes pending tasks section", () => {
    const task = createTask("Fix bug");
    const summary = formatResumeSummary({
      pendingTasks: [task],
      activeTasks: [],
      waitingHumanTasks: [],
      activeMissions: [],
      unreadReports: [],
      newFeedback: [],
    });

    expect(summary).toContain("Pending");
    expect(summary).toContain("Fix bug");
  });

  test("includes waiting_human tasks section", () => {
    const task = createTask("Needs decision");
    const summary = formatResumeSummary({
      pendingTasks: [],
      activeTasks: [],
      waitingHumanTasks: [task],
      activeMissions: [],
      unreadReports: [],
      newFeedback: [],
    });

    expect(summary).toContain("Waiting");
    expect(summary).toContain("Needs decision");
  });

  test("includes active tasks section", () => {
    const task = createTask("In progress");
    const summary = formatResumeSummary({
      pendingTasks: [],
      activeTasks: [task],
      waitingHumanTasks: [],
      activeMissions: [],
      unreadReports: [],
      newFeedback: [],
    });

    expect(summary).toContain("Active");
    expect(summary).toContain("In progress");
  });

  test("includes missions section", () => {
    const summary = formatResumeSummary({
      pendingTasks: [],
      activeTasks: [],
      waitingHumanTasks: [],
      activeMissions: [{ id: "m1", name: "Ship v2", filter: {}, principles: [], status: "active", createdAt: "" }],
      unreadReports: [],
      newFeedback: [],
    });

    expect(summary).toContain("Mission");
    expect(summary).toContain("Ship v2");
  });

  test("includes unread reports section", () => {
    const summary = formatResumeSummary({
      pendingTasks: [],
      activeTasks: [],
      waitingHumanTasks: [],
      activeMissions: [],
      unreadReports: [{ id: "r1", title: "完了報告", content: "", status: "unread", createdBy: "agent", createdAt: "" }],
      newFeedback: [],
    });

    expect(summary).toContain("Report");
    expect(summary).toContain("完了報告");
  });

  test("includes new feedback section", () => {
    const summary = formatResumeSummary({
      pendingTasks: [],
      activeTasks: [],
      waitingHumanTasks: [],
      activeMissions: [],
      unreadReports: [],
      newFeedback: [{ id: "f1", from: "user", message: "Please fix this", status: "new", createdAt: "" }],
    });

    expect(summary).toContain("Feedback");
    expect(summary).toContain("Please fix this");
  });

  test("combines all sections", () => {
    const summary = formatResumeSummary({
      pendingTasks: [createTask("Task A")],
      activeTasks: [createTask("Task B")],
      waitingHumanTasks: [createTask("Task C")],
      activeMissions: [{ id: "m1", name: "Mission X", filter: {}, principles: [], status: "active", createdAt: "" }],
      unreadReports: [{ id: "r1", title: "Report Y", content: "", status: "unread", createdBy: "agent", createdAt: "" }],
      newFeedback: [{ id: "f1", from: "user", message: "Feedback Z", status: "new", createdAt: "" }],
    });

    expect(summary).toContain("Task A");
    expect(summary).toContain("Task B");
    expect(summary).toContain("Task C");
    expect(summary).toContain("Mission X");
    expect(summary).toContain("Report Y");
    expect(summary).toContain("Feedback Z");
  });
});
