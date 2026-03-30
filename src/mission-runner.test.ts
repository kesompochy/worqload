import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { createTask } from "./task";
import { TaskQueue } from "./queue";
import { createMission, completeMission, addMissionPrinciple, loadMissions } from "./mission";
import { findNextMissionTask, processTask, processPlanTask, iterate } from "./mission-runner";
import { load } from "./store";

function tmpPath(label: string): string {
  return join(tmpdir(), `worqload-mrunner-${label}-${crypto.randomUUID()}.json`);
}

async function setupQueue(storePath: string, tasks: ReturnType<typeof createTask>[]): Promise<void> {
  const queue = new TaskQueue(storePath);
  for (const task of tasks) {
    queue.enqueue(task);
  }
  await queue.save();
}

describe("findNextMissionTask", () => {
  test("returns unclaimed observing task for mission", () => {
    const queue = new TaskQueue();
    const missionId = crypto.randomUUID();
    const task = createTask("test task");
    queue.enqueue(task);
    queue.update(task.id, { missionId });

    const result = findNextMissionTask(queue, missionId);
    expect(result?.id).toBe(task.id);
  });

  test("returns undefined when no tasks for mission", () => {
    const queue = new TaskQueue();
    const result = findNextMissionTask(queue, crypto.randomUUID());
    expect(result).toBeUndefined();
  });

  test("skips claimed tasks", () => {
    const queue = new TaskQueue();
    const missionId = crypto.randomUUID();
    const task = createTask("claimed task");
    queue.enqueue(task);
    queue.update(task.id, { missionId, owner: "someone" });

    const result = findNextMissionTask(queue, missionId);
    expect(result).toBeUndefined();
  });

  test("skips non-observing tasks", () => {
    const queue = new TaskQueue();
    const missionId = crypto.randomUUID();
    const task = createTask("orienting task");
    queue.enqueue(task);
    queue.update(task.id, { missionId });
    queue.transition(task.id, "orienting");

    const result = findNextMissionTask(queue, missionId);
    expect(result).toBeUndefined();
  });

  test("picks highest priority task", () => {
    const queue = new TaskQueue();
    const missionId = crypto.randomUUID();
    const low = createTask("low priority", {}, 1);
    const high = createTask("high priority", {}, 10);
    queue.enqueue(low);
    queue.enqueue(high);
    queue.update(low.id, { missionId });
    queue.update(high.id, { missionId });

    const result = findNextMissionTask(queue, missionId);
    expect(result?.id).toBe(high.id);
  });

  test("ignores tasks from other missions", () => {
    const queue = new TaskQueue();
    const missionId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const task = createTask("other mission task");
    queue.enqueue(task);
    queue.update(task.id, { missionId: otherId });

    const result = findNextMissionTask(queue, missionId);
    expect(result).toBeUndefined();
  });
});

describe("processTask", () => {
  test("transitions through all OODA phases to done", async () => {
    const storePath = tmpPath("process-done");
    const missionPath = tmpPath("process-done-m");
    const mission = await createMission("test-mission", {}, missionPath);
    const task = createTask("process me");
    const taskWithMission = { ...task, missionId: mission.id };
    await setupQueue(storePath, [taskWithMission]);

    await processTask(task, mission, storePath);

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.owner).toBeUndefined();
  });

  test("logs mission principles in observe phase", async () => {
    const storePath = tmpPath("principles");
    const missionPath = tmpPath("principles-m");
    const mission = await createMission("principle-mission", {}, missionPath);
    await addMissionPrinciple(mission.id, "Always test first", missionPath);
    const missions = await loadMissions(missionPath);
    const updatedMission = missions[0];

    const task = createTask("principle task");
    await setupQueue(storePath, [{ ...task, missionId: updatedMission.id }]);

    await processTask(task, updatedMission, storePath);

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    const observeLog = updated?.logs.find(l => l.phase === "observe");
    expect(observeLog?.content).toContain("Always test first");
  });

  test("has logs for all OODA phases", async () => {
    const storePath = tmpPath("all-phases");
    const missionPath = tmpPath("all-phases-m");
    const mission = await createMission("all-phases", {}, missionPath);
    const task = createTask("all phases task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, storePath);

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    const phases = updated?.logs.map(l => l.phase);
    expect(phases).toContain("observe");
    expect(phases).toContain("orient");
    expect(phases).toContain("decide");
    expect(phases).toContain("act");
  });

  test("throws when task is already claimed", async () => {
    const storePath = tmpPath("already-claimed");
    const missionPath = tmpPath("already-claimed-m");
    const mission = await createMission("claim-mission", {}, missionPath);
    const task = createTask("claimed task");
    const queue = new TaskQueue(storePath);
    queue.enqueue(task);
    queue.update(task.id, { missionId: mission.id, owner: "other-agent" });
    await queue.save();

    expect(processTask(task, mission, storePath)).rejects.toThrow("Already claimed");

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("observing");
    expect(updated?.owner).toBe("other-agent");
  });

  test("sets owner to mission:<name> during processing", async () => {
    const storePath = tmpPath("owner");
    const missionPath = tmpPath("owner-m");
    const mission = await createMission("owner-test", {}, missionPath);
    const task = createTask("owner task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, storePath);

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    // Owner cleared after done
    expect(updated?.owner).toBeUndefined();
    // But logs should show the mission agent processed it
    const doneLog = updated?.logs.find(l => l.content.includes("Completed by mission agent"));
    expect(doneLog).toBeDefined();
  });
});

describe("iterate", () => {
  test("returns mission_completed when mission is completed", async () => {
    const missionPath = tmpPath("iter-completed-m");
    const storePath = tmpPath("iter-completed");
    const mission = await createMission("completed", {}, missionPath);
    await completeMission(mission.id, missionPath);

    const result = await iterate(mission.id, { storePath, missionsPath: missionPath });
    expect(result).toBe("mission_completed");
  });

  test("returns idle when no tasks available", async () => {
    const missionPath = tmpPath("iter-idle-m");
    const storePath = tmpPath("iter-idle");
    const mission = await createMission("idle-mission", {}, missionPath);
    const queue = new TaskQueue(storePath);
    await queue.save();

    const result = await iterate(mission.id, { storePath, missionsPath: missionPath });
    expect(result).toBe("idle");
  });

  test("returns processed after processing a task", async () => {
    const missionPath = tmpPath("iter-process-m");
    const storePath = tmpPath("iter-process");
    const mission = await createMission("process-mission", {}, missionPath);
    const task = createTask("to process");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await iterate(mission.id, { storePath, missionsPath: missionPath });
    expect(result).toBe("processed");

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
  });

  test("throws for non-existent mission", async () => {
    const missionPath = tmpPath("iter-notfound-m");
    const storePath = tmpPath("iter-notfound");

    expect(iterate("nonexistent", { storePath, missionsPath: missionPath }))
      .rejects.toThrow("Mission not found");
  });

  test("processes multiple tasks sequentially", async () => {
    const missionPath = tmpPath("iter-multi-m");
    const storePath = tmpPath("iter-multi");
    const mission = await createMission("multi-mission", {}, missionPath);
    const task1 = createTask("first task");
    const task2 = createTask("second task");
    await setupQueue(storePath, [
      { ...task1, missionId: mission.id },
      { ...task2, missionId: mission.id },
    ]);

    const result1 = await iterate(mission.id, { storePath, missionsPath: missionPath });
    expect(result1).toBe("processed");

    const result2 = await iterate(mission.id, { storePath, missionsPath: missionPath });
    expect(result2).toBe("processed");

    const result3 = await iterate(mission.id, { storePath, missionsPath: missionPath });
    expect(result3).toBe("idle");

    const tasks = await load(storePath);
    expect(tasks.filter(t => t.status === "done")).toHaveLength(2);
  });

  test("resolves mission by id prefix", async () => {
    const missionPath = tmpPath("iter-prefix-m");
    const storePath = tmpPath("iter-prefix");
    const mission = await createMission("prefix-mission", {}, missionPath);
    const queue = new TaskQueue(storePath);
    await queue.save();

    const result = await iterate(mission.id.slice(0, 8), { storePath, missionsPath: missionPath });
    expect(result).toBe("idle");
  });
});

describe("processPlanTask", () => {
  test("creates subtasks from context.subtasks and marks plan as done", async () => {
    const storePath = tmpPath("plan-subtasks");
    const missionPath = tmpPath("plan-subtasks-m");
    const mission = await createMission("plan-mission", {}, missionPath);
    const task = createTask("parent plan");
    const planTask = {
      ...task,
      missionId: mission.id,
      context: { plan: true, subtasks: ["subtask A", "subtask B", "subtask C"] },
    };
    await setupQueue(storePath, [planTask]);

    await processPlanTask(task, mission, storePath);

    const tasks = await load(storePath);
    const parent = tasks.find(t => t.id === task.id);
    expect(parent?.status).toBe("done");
    expect(parent?.owner).toBeUndefined();

    const subtasks = tasks.filter(t => t.id !== task.id);
    expect(subtasks).toHaveLength(3);
    expect(subtasks.map(s => s.title).sort()).toEqual(["subtask A", "subtask B", "subtask C"]);
    for (const sub of subtasks) {
      expect(sub.missionId).toBe(mission.id);
      expect(sub.status).toBe("observing");
    }
  });

  test("logs delegation in observe phase", async () => {
    const storePath = tmpPath("plan-log");
    const missionPath = tmpPath("plan-log-m");
    const mission = await createMission("log-mission", {}, missionPath);
    const task = createTask("plan with log");
    const planTask = {
      ...task,
      missionId: mission.id,
      context: { plan: true, subtasks: ["sub1"] },
    };
    await setupQueue(storePath, [planTask]);

    await processPlanTask(task, mission, storePath);

    const tasks = await load(storePath);
    const parent = tasks.find(t => t.id === task.id);
    const observeLog = parent?.logs.find(l => l.phase === "observe");
    expect(observeLog?.content).toContain("plan with log");
    const actLog = parent?.logs.find(l => l.content.includes("Delegated"));
    expect(actLog).toBeDefined();
  });

  test("throws when subtasks array is empty", async () => {
    const storePath = tmpPath("plan-empty");
    const missionPath = tmpPath("plan-empty-m");
    const mission = await createMission("empty-mission", {}, missionPath);
    const task = createTask("empty plan");
    const planTask = {
      ...task,
      missionId: mission.id,
      context: { plan: true, subtasks: [] },
    };
    await setupQueue(storePath, [planTask]);

    expect(processPlanTask(task, mission, storePath)).rejects.toThrow("no subtasks");
  });

  test("throws when subtasks is missing from context", async () => {
    const storePath = tmpPath("plan-missing");
    const missionPath = tmpPath("plan-missing-m");
    const mission = await createMission("missing-mission", {}, missionPath);
    const task = createTask("no subtasks plan");
    const planTask = {
      ...task,
      missionId: mission.id,
      context: { plan: true },
    };
    await setupQueue(storePath, [planTask]);

    expect(processPlanTask(task, mission, storePath)).rejects.toThrow("no subtasks");
  });

  test("processTask delegates to processPlanTask for plan tasks", async () => {
    const storePath = tmpPath("plan-delegate");
    const missionPath = tmpPath("plan-delegate-m");
    const mission = await createMission("delegate-mission", {}, missionPath);
    const task = createTask("delegated plan");
    const planTask = {
      ...task,
      missionId: mission.id,
      context: { plan: true, subtasks: ["child1", "child2"] },
    };
    await setupQueue(storePath, [planTask]);

    await processTask(task, mission, storePath);

    const tasks = await load(storePath);
    const parent = tasks.find(t => t.id === task.id);
    expect(parent?.status).toBe("done");
    const children = tasks.filter(t => t.id !== task.id);
    expect(children).toHaveLength(2);
  });

  test("iterate processes plan tasks and creates subtasks", async () => {
    const storePath = tmpPath("plan-iterate");
    const missionPath = tmpPath("plan-iterate-m");
    const mission = await createMission("iterate-plan", {}, missionPath);
    const task = createTask("iter plan");
    const planTask = {
      ...task,
      missionId: mission.id,
      context: { plan: true, subtasks: ["step1", "step2"] },
    };
    await setupQueue(storePath, [planTask]);

    const result = await iterate(mission.id, { storePath, missionsPath: missionPath });
    expect(result).toBe("processed");

    const tasks = await load(storePath);
    const parent = tasks.find(t => t.id === task.id);
    expect(parent?.status).toBe("done");
    const subtasks = tasks.filter(t => t.id !== task.id);
    expect(subtasks).toHaveLength(2);
    expect(subtasks.every(s => s.missionId === mission.id)).toBe(true);
  });
});
