import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { createTask } from "./task";
import { TaskQueue } from "./queue";
import { createMission, completeMission, addMissionPrinciple, loadMissions, type Mission } from "./mission";
import { findNextMissionTask, processTask, processPlanTask, iterateMission, spawnTask, runMission, orientTask, ensureReportForDoneTask, shouldForceEscalation, ORIENT_ESCALATION_WINDOW } from "./mission-runner";
import { HUMAN_REQUIRED_PREFIX, ESCALATION_EXIT_CODE } from "./task";
import { load } from "./store";
import { loadSpawns } from "./spawns";
import { loadReports, addReport } from "./reports";

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

function makeHumanReviewedTask(missionId: string): ReturnType<typeof createTask> {
  const task = createTask("human-reviewed seed");
  task.status = "done" as const;
  task.missionId = missionId;
  task.logs.push({ phase: "orient" as const, content: `${HUMAN_REQUIRED_PREFIX}reviewed`, timestamp: new Date().toISOString() });
  return task;
}

async function createMissionWithPrinciple(name: string, missionPath: string, principle = "Execute task"): Promise<Mission> {
  const mission = await createMission(name, {}, missionPath);
  await addMissionPrinciple(mission.id, principle, missionPath);
  const missions = await loadMissions(missionPath);
  return missions.find(m => m.id === mission.id)!;
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

  test("skips tasks past orienting phase", () => {
    const queue = new TaskQueue();
    const missionId = crypto.randomUUID();
    const task = createTask("deciding task");
    queue.enqueue(task);
    queue.update(task.id, { missionId });
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "deciding");

    const result = findNextMissionTask(queue, missionId);
    expect(result).toBeUndefined();
  });

  test("picks orienting tasks (human-answered)", () => {
    const queue = new TaskQueue();
    const missionId = crypto.randomUUID();
    const task = createTask("answered task");
    queue.enqueue(task);
    queue.update(task.id, { missionId });
    queue.transition(task.id, "orienting");

    const result = findNextMissionTask(queue, missionId);
    expect(result).toBeDefined();
    expect(result!.id).toBe(task.id);
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
    const mission = await createMissionWithPrinciple("test-mission", missionPath);
    const task = createTask("process me");
    const taskWithMission = { ...task, missionId: mission.id };
    await setupQueue(storePath, [makeHumanReviewedTask(mission.id), taskWithMission]);

    await processTask(task, mission, { storePath, actCommand: ["echo"] });

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

    await processTask(task, updatedMission, { storePath, actCommand: ["echo"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    const observeLog = updated?.logs.find(l => l.phase === "observe");
    expect(observeLog?.content).toContain("Always test first");
  });

  test("has logs for all OODA phases", async () => {
    const storePath = tmpPath("all-phases");
    const missionPath = tmpPath("all-phases-m");
    const mission = await createMissionWithPrinciple("all-phases", missionPath);
    const task = createTask("all phases task");
    await setupQueue(storePath, [makeHumanReviewedTask(mission.id), { ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["echo"] });

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

    expect(processTask(task, mission, { storePath, actCommand: ["echo"] })).rejects.toThrow("Already claimed");

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("observing");
    expect(updated?.owner).toBe("other-agent");
  });

  test("sets owner to mission:<name> during processing", async () => {
    const storePath = tmpPath("owner");
    const missionPath = tmpPath("owner-m");
    const mission = await createMissionWithPrinciple("owner-test", missionPath);
    const task = createTask("owner task");
    await setupQueue(storePath, [makeHumanReviewedTask(mission.id), { ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["echo"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    // Owner cleared after done
    expect(updated?.owner).toBeUndefined();
    // Act log should contain spawn output with task title
    const actLog = updated?.logs.find(l => l.phase === "act" && l.content.includes(task.title));
    expect(actLog).toBeDefined();
  });

  test("spawns process in act phase and captures output", async () => {
    const storePath = tmpPath("spawn-act");
    const missionPath = tmpPath("spawn-act-m");
    const mission = await createMissionWithPrinciple("spawn-act", missionPath);
    const task = createTask("spawn act task");
    await setupQueue(storePath, [makeHumanReviewedTask(mission.id), { ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["echo"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
    const actLog = updated?.logs.find(l => l.phase === "act" && l.content.includes(task.title));
    expect(actLog).toBeDefined();
  });

  test("marks task as failed when act spawn exits non-zero", async () => {
    const storePath = tmpPath("act-fail");
    const missionPath = tmpPath("act-fail-m");
    const mission = await createMissionWithPrinciple("act-fail", missionPath);
    const task = createTask("fail act task", { retryCount: 2 });
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["sh", "-c", "exit 1"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("failed");
    const failLog = updated?.logs.find(l => l.content.includes("[FAILED]"));
    expect(failLog).toBeDefined();
  });

  test("includes mission principles in act prompt", async () => {
    const storePath = tmpPath("act-principles");
    const missionPath = tmpPath("act-principles-m");
    const mission = await createMission("act-principle", {}, missionPath);
    await addMissionPrinciple(mission.id, "TDD always", missionPath);
    const missions = await loadMissions(missionPath);
    const principledMission = missions[0];

    const task = createTask("act with principles");
    await setupQueue(storePath, [{ ...task, missionId: principledMission.id }]);

    await processTask(task, principledMission, { storePath, actCommand: ["echo"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    const actLog = updated?.logs.find(l => l.phase === "act" && l.content.includes("TDD always"));
    expect(actLog).toBeDefined();
  });

  test("includes task context in act prompt", async () => {
    const storePath = tmpPath("act-context");
    const missionPath = tmpPath("act-context-m");
    const mission = await createMissionWithPrinciple("act-context", missionPath);
    const task = createTask("context task", { detail: "important info" });
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["echo"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    const actLog = updated?.logs.find(l => l.phase === "act" && l.content.includes("important info"));
    expect(actLog).toBeDefined();
  });
});

describe("iterateMission", () => {
  test("returns mission_completed when mission is completed", async () => {
    const missionPath = tmpPath("iter-completed-m");
    const storePath = tmpPath("iter-completed");
    const mission = await createMission("completed", {}, missionPath);
    await completeMission(mission.id, missionPath);

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result).toBe("mission_completed");
  });

  test("returns idle when no tasks available", async () => {
    const missionPath = tmpPath("iter-idle-m");
    const storePath = tmpPath("iter-idle");
    const mission = await createMission("idle-mission", {}, missionPath);
    const queue = new TaskQueue(storePath);
    await queue.save();

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result).toBe("idle");
  });

  test("returns processed after processing a task", async () => {
    const missionPath = tmpPath("iter-process-m");
    const storePath = tmpPath("iter-process");
    const mission = await createMissionWithPrinciple("process-mission", missionPath);
    const task = createTask("to process");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result).toBe("processed");

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
  });

  test("throws for non-existent mission", async () => {
    const missionPath = tmpPath("iter-notfound-m");
    const storePath = tmpPath("iter-notfound");

    expect(iterateMission("nonexistent", { storePath, missionsPath: missionPath, actCommand: ["echo"] }))
      .rejects.toThrow("Mission not found");
  });

  test("processes multiple tasks sequentially", async () => {
    const missionPath = tmpPath("iter-multi-m");
    const storePath = tmpPath("iter-multi");
    const mission = await createMissionWithPrinciple("multi-mission", missionPath);
    const task1 = createTask("first task");
    const task2 = createTask("second task");
    await setupQueue(storePath, [
      { ...task1, missionId: mission.id },
      { ...task2, missionId: mission.id },
    ]);

    const result1 = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result1).toBe("processed");

    const result2 = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result2).toBe("processed");

    // All tasks done → auto-complete triggers
    const result3 = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result3).toBe("mission_completed");

    const tasks = await load(storePath);
    expect(tasks.filter(t => t.status === "done")).toHaveLength(2);
  });

  test("resolves mission by id prefix", async () => {
    const missionPath = tmpPath("iter-prefix-m");
    const storePath = tmpPath("iter-prefix");
    const mission = await createMission("prefix-mission", {}, missionPath);
    const queue = new TaskQueue(storePath);
    await queue.save();

    const result = await iterateMission(mission.id.slice(0, 8), { storePath, missionsPath: missionPath, actCommand: ["echo"] });
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

    await processTask(task, mission, { storePath, actCommand: ["echo"] });

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

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result).toBe("processed");

    const tasks = await load(storePath);
    const parent = tasks.find(t => t.id === task.id);
    expect(parent?.status).toBe("done");
    const subtasks = tasks.filter(t => t.id !== task.id);
    expect(subtasks).toHaveLength(2);
    expect(subtasks.every(s => s.missionId === mission.id)).toBe(true);
  });
});

describe("spawnTask", () => {
  test("claims task and marks done on successful subprocess", async () => {
    const storePath = tmpPath("spawn-basic");
    const missionPath = tmpPath("spawn-basic-m");
    const spawnsPath = tmpPath("spawn-basic-s");
    const mission = await createMission("spawn-mission", {}, missionPath);
    const task = createTask("spawn me");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await spawnTask(task, mission, ["echo", "hello"], { storePath, spawnsPath });
    expect(result.pid).toBeGreaterThan(0);

    const completion = await result.completion;
    expect(completion.exitCode).toBe(0);

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.owner).toBeUndefined();
  });

  test("marks task as failed on non-zero exit", async () => {
    const storePath = tmpPath("spawn-fail");
    const missionPath = tmpPath("spawn-fail-m");
    const spawnsPath = tmpPath("spawn-fail-s");
    const mission = await createMission("fail-mission", {}, missionPath);
    const task = createTask("fail me", { retryCount: 2 });
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await spawnTask(task, mission, ["sh", "-c", "exit 1"], { storePath, spawnsPath });
    const completion = await result.completion;
    expect(completion.exitCode).toBe(1);

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("failed");
  });

  test("passes task env variables to subprocess", async () => {
    const storePath = tmpPath("spawn-env");
    const missionPath = tmpPath("spawn-env-m");
    const spawnsPath = tmpPath("spawn-env-s");
    const mission = await createMission("env-mission", {}, missionPath);
    const task = createTask("env task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await spawnTask(task, mission, ["sh", "-c", "echo $WORQLOAD_TASK_ID"], { storePath, spawnsPath });
    const completion = await result.completion;
    expect(completion.output).toContain(task.id);
  });

  test("passes WORQLOAD_CLI env variable to subprocess", async () => {
    const storePath = tmpPath("spawn-cli");
    const missionPath = tmpPath("spawn-cli-m");
    const spawnsPath = tmpPath("spawn-cli-s");
    const mission = await createMission("cli-mission", {}, missionPath);
    const task = createTask("cli task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await spawnTask(task, mission, ["sh", "-c", "echo $WORQLOAD_CLI"], { storePath, spawnsPath });
    const completion = await result.completion;
    expect(completion.output).toContain("worqload");
  });

  test("passes mission principles as env variable", async () => {
    const storePath = tmpPath("spawn-principles");
    const missionPath = tmpPath("spawn-principles-m");
    const spawnsPath = tmpPath("spawn-principles-s");
    const mission = await createMission("principle-mission", {}, missionPath);
    await addMissionPrinciple(mission.id, "test first", missionPath);
    const missions = await loadMissions(missionPath);
    const updatedMission = missions[0];

    const task = createTask("principle spawn");
    await setupQueue(storePath, [{ ...task, missionId: updatedMission.id }]);

    const result = await spawnTask(task, updatedMission, ["sh", "-c", "echo $WORQLOAD_MISSION_PRINCIPLES"], { storePath, spawnsPath });
    const completion = await result.completion;
    expect(completion.output).toContain("test first");
  });

  test("records spawn in spawns store", async () => {
    const storePath = tmpPath("spawn-record");
    const missionPath = tmpPath("spawn-record-m");
    const spawnsPath = tmpPath("spawn-record-s");
    const mission = await createMission("record-mission", {}, missionPath);
    const task = createTask("record task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await spawnTask(task, mission, ["echo", "hi"], { storePath, spawnsPath });
    await result.completion;

    const spawns = await loadSpawns(spawnsPath);
    const spawnRecord = spawns.find(s => s.id === result.spawnId);
    expect(spawnRecord).toBeDefined();
    expect(spawnRecord?.status).toBe("done");
    expect(spawnRecord?.taskId).toBe(task.id);
  });

  test("transitions to waiting_human on escalation exit code", async () => {
    const storePath = tmpPath("spawn-escalate");
    const missionPath = tmpPath("spawn-escalate-m");
    const spawnsPath = tmpPath("spawn-escalate-s");
    const mission = await createMission("escalate-mission", {}, missionPath);
    const task = createTask("needs human");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await spawnTask(
      task, mission,
      ["sh", "-c", `echo "I need help with this"; exit ${ESCALATION_EXIT_CODE}`],
      { storePath, spawnsPath },
    );
    const completion = await result.completion;
    expect(completion.exitCode).toBe(ESCALATION_EXIT_CODE);

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("waiting_human");
    expect(updated?.owner).toBeUndefined();
    const lastLog = updated?.logs[updated.logs.length - 1];
    expect(lastLog?.content).toMatch(/\[HUMAN REQUIRED\]/);
  });

  test("throws when task is already claimed", async () => {
    const storePath = tmpPath("spawn-claimed");
    const missionPath = tmpPath("spawn-claimed-m");
    const spawnsPath = tmpPath("spawn-claimed-s");
    const mission = await createMission("claimed-mission", {}, missionPath);
    const task = createTask("already claimed");
    const queue = new TaskQueue(storePath);
    queue.enqueue(task);
    queue.update(task.id, { missionId: mission.id, owner: "other" });
    await queue.save();

    expect(spawnTask(task, mission, ["echo"], { storePath, spawnsPath })).rejects.toThrow("Already claimed");
  });
});

describe("mission auto-complete", () => {
  test("auto-completes mission when all tasks are done", async () => {
    const missionPath = tmpPath("auto-done-m");
    const storePath = tmpPath("auto-done");
    const mission = await createMissionWithPrinciple("auto-done", missionPath);
    const task1 = createTask("task 1");
    const task2 = createTask("task 2");
    await setupQueue(storePath, [
      { ...task1, missionId: mission.id },
      { ...task2, missionId: mission.id },
    ]);

    await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result).toBe("mission_completed");

    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("completed");
  });

  test("fails mission when all tasks are failed", async () => {
    const missionPath = tmpPath("auto-fail-m");
    const storePath = tmpPath("auto-fail");
    const mission = await createMission("auto-fail", {}, missionPath);
    const task = createTask("will fail");
    const queue = new TaskQueue(storePath);
    queue.enqueue({ ...task, missionId: mission.id });
    queue.transition(task.id, "failed");
    await queue.save();

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result).toBe("mission_failed");

    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("failed");
  });

  test("fails mission with mix of done and failed tasks", async () => {
    const missionPath = tmpPath("auto-mix-m");
    const storePath = tmpPath("auto-mix");
    const mission = await createMission("auto-mix", {}, missionPath);
    const done = createTask("done task");
    const failed = createTask("failed task");
    const queue = new TaskQueue(storePath);
    queue.enqueue({ ...done, missionId: mission.id });
    queue.enqueue({ ...failed, missionId: mission.id });
    queue.transition(done.id, "done");
    queue.transition(failed.id, "failed");
    await queue.save();

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result).toBe("mission_failed");

    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("failed");
  });

  test("does not auto-complete when tasks are in progress", async () => {
    const missionPath = tmpPath("auto-inprog-m");
    const storePath = tmpPath("auto-inprog");
    const mission = await createMission("auto-inprog", {}, missionPath);
    const done = createTask("done task");
    const acting = createTask("acting task");
    const queue = new TaskQueue(storePath);
    queue.enqueue({ ...done, missionId: mission.id });
    queue.enqueue({ ...acting, missionId: mission.id });
    queue.transition(done.id, "done");
    queue.transition(acting.id, "orienting");
    queue.update(acting.id, { owner: "someone" });
    await queue.save();

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result).toBe("idle");

    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("active");
  });

  test("does not auto-complete when 1 done + 1 observing task", async () => {
    const missionPath = tmpPath("auto-obs-m");
    const storePath = tmpPath("auto-obs");
    const mission = await createMission("auto-obs", {}, missionPath);
    const doneTask = createTask("done task");
    const observingTask = createTask("observing task");
    const queue = new TaskQueue(storePath);
    queue.enqueue({ ...doneTask, missionId: mission.id });
    queue.enqueue({ ...observingTask, missionId: mission.id });
    queue.transition(doneTask.id, "done");
    queue.update(observingTask.id, { owner: "other-runner" });
    await queue.save();

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result).toBe("idle");

    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("active");
  });

  test("returns idle when mission has no tasks", async () => {
    const missionPath = tmpPath("auto-empty-m");
    const storePath = tmpPath("auto-empty");
    const mission = await createMission("auto-empty", {}, missionPath);
    const queue = new TaskQueue(storePath);
    await queue.save();

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath, actCommand: ["echo"] });
    expect(result).toBe("idle");

    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("active");
  });
});

describe("runMission persistence", () => {
  test("polls for new tasks when initially idle", async () => {
    const missionPath = tmpPath("run-poll-m");
    const storePath = tmpPath("run-poll");
    const mission = await createMissionWithPrinciple("poll-mission", missionPath);
    const queue = new TaskQueue(storePath);
    await queue.save();

    setTimeout(async () => {
      const task = createTask("delayed task");
      const q = new TaskQueue(storePath);
      await q.load();
      q.enqueue({ ...task, missionId: mission.id });
      await q.save();
    }, 50);

    await runMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      runnerStatePath: tmpPath("runners"),
      pollIntervalMs: 10,
      idleTimeoutMs: 2000,
      actCommand: ["echo"],
    });

    const tasks = await load(storePath);
    const processed = tasks.find(t => t.status === "done");
    expect(processed).toBeDefined();
  });

  test("exits after idle timeout when no tasks appear", async () => {
    const missionPath = tmpPath("run-idle-m");
    const storePath = tmpPath("run-idle");
    const mission = await createMission("idle-timeout", {}, missionPath);
    const queue = new TaskQueue(storePath);
    await queue.save();

    const start = Date.now();
    await runMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      runnerStatePath: tmpPath("runners"),
      pollIntervalMs: 10,
      idleTimeoutMs: 100,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2000);
  });

  test("exits on mission completion instead of idle timeout", async () => {
    const missionPath = tmpPath("run-complete-m");
    const storePath = tmpPath("run-complete");
    const mission = await createMissionWithPrinciple("complete-mission", missionPath);
    const task = createTask("the only task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const start = Date.now();
    await runMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      runnerStatePath: tmpPath("runners"),
      pollIntervalMs: 10,
      idleTimeoutMs: 5000,
      actCommand: ["echo"],
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(3000);
    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("completed");
  });

  test("resets idle timer when a task is processed", async () => {
    const missionPath = tmpPath("run-reset-idle-m");
    const storePath = tmpPath("run-reset-idle");
    const mission = await createMissionWithPrinciple("reset-idle", missionPath);

    const task1 = createTask("task1");
    const blocker = createTask("blocker");
    const queue = new TaskQueue(storePath);
    queue.enqueue({ ...task1, missionId: mission.id });
    queue.enqueue({ ...blocker, missionId: mission.id });
    queue.transition(blocker.id, "orienting");
    queue.update(blocker.id, { owner: "other" });
    await queue.save();

    setTimeout(async () => {
      const q = new TaskQueue(storePath);
      await q.load();
      q.enqueue({ ...createTask("task2"), missionId: mission.id });
      await q.save();
    }, 50);

    // Without idle timer reset, runner exits at t~300ms before this fires.
    // With reset, task2 at ~50ms resets idle, so runner survives until ~350ms+.
    setTimeout(async () => {
      const q = new TaskQueue(storePath);
      await q.load();
      q.enqueue({ ...createTask("task3"), missionId: mission.id });
      q.transition(blocker.id, "done");
      q.update(blocker.id, { owner: undefined });
      await q.save();
    }, 150);

    await runMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      runnerStatePath: tmpPath("runners"),
      pollIntervalMs: 10,
      idleTimeoutMs: 300,
      actCommand: ["echo"],
    });

    const tasks = await load(storePath);
    const doneTasks = tasks.filter(t => t.status === "done");
    expect(doneTasks.length).toBeGreaterThanOrEqual(4);
  });

  test("default idle timeout is 30 minutes", async () => {
    const missionPath = tmpPath("run-default-timeout-m");
    const storePath = tmpPath("run-default-timeout");
    const mission = await createMission("default-timeout", {}, missionPath);
    const queue = new TaskQueue(storePath);
    await queue.save();

    const abortResult = await Promise.race([
      runMission(mission.id, {
        storePath,
        missionsPath: missionPath,
        runnerStatePath: tmpPath("runners-default-timeout"),
        pollIntervalMs: 10,
      }).then(() => "runner_exited"),
      Bun.sleep(200).then(() => "timeout"),
    ]);

    expect(abortResult).toBe("timeout");
  });
});

describe("runMission error handling", () => {
  test("throws after maxRetries consecutive errors instead of retrying forever", async () => {
    const missionPath = tmpPath("run-retry-m");
    const storePath = tmpPath("run-retry");
    const mission = await createMission("retry-mission", {}, missionPath);

    // Write invalid JSON so iterate always throws on queue.load()
    await Bun.write(storePath, "invalid json");

    await expect(runMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      runnerStatePath: tmpPath("runners"),
      maxRetries: 3,
      retryBaseMs: 1,
    })).rejects.toThrow(/retry limit.*3/i);
  });

  test("applies exponential backoff between retries", async () => {
    const missionPath = tmpPath("run-backoff-m");
    const storePath = tmpPath("run-backoff");
    const mission = await createMission("backoff-mission", {}, missionPath);
    await Bun.write(storePath, "invalid json");

    const start = Date.now();
    try {
      await runMission(mission.id, {
        storePath,
        missionsPath: missionPath,
      runnerStatePath: tmpPath("runners"),
        maxRetries: 4,
        retryBaseMs: 20,
      });
    } catch {
      // expected
    }
    const elapsed = Date.now() - start;

    // Exponential: 20 + 40 + 80 = 140ms total backoff (3 waits before 4th attempt throws)
    // With constant 20ms: 20 + 20 + 20 = 60ms
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  test("resets retry counter on successful iteration", async () => {
    const missionPath = tmpPath("run-reset-m");
    const storePath = tmpPath("run-reset");
    const mission = await createMission("reset-mission", {}, missionPath);

    // Set up valid store with a processable task and an in-progress task
    // (in-progress task prevents auto-complete after the first task finishes)
    const task = createTask("succeed once");
    const inProgress = createTask("in progress");
    const queue = new TaskQueue(storePath);
    queue.enqueue({ ...task, missionId: mission.id });
    queue.enqueue({ ...inProgress, missionId: mission.id });
    queue.transition(inProgress.id, "orienting");
    queue.update(inProgress.id, { owner: "other-agent" });
    await queue.save();

    // After first iterate processes the task, corrupt the store for subsequent calls.
    const corruptAfter = 50;
    setTimeout(async () => {
      await Bun.write(storePath, "invalid json");
    }, corruptAfter);

    // maxRetries=2 means it tolerates 2 consecutive errors.
    // If the counter weren't reset after the first success, it would only tolerate 1 more.
    // Since we corrupt after success, the counter should restart from 0.
    await expect(runMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      runnerStatePath: tmpPath("runners"),
      maxRetries: 2,
      retryBaseMs: 1,
      pollIntervalMs: 10,
      idleTimeoutMs: 500,
      actCommand: ["echo"],
    })).rejects.toThrow(/retry limit.*2/i);
  });

  test("includes last error message in the thrown error", async () => {
    const missionPath = tmpPath("run-errmsg-m");
    const storePath = tmpPath("run-errmsg");
    const mission = await createMission("errmsg-mission", {}, missionPath);
    await Bun.write(storePath, "invalid json");

    await expect(runMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      runnerStatePath: tmpPath("runners"),
      maxRetries: 1,
      retryBaseMs: 1,
    })).rejects.toThrow(/JSON/i);
  });

  test("uses default maxRetries of 5 when not specified", async () => {
    const missionPath = tmpPath("run-default-m");
    const storePath = tmpPath("run-default");
    const mission = await createMission("default-mission", {}, missionPath);
    await Bun.write(storePath, "invalid json");

    await expect(runMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      runnerStatePath: tmpPath("runners"),
      retryBaseMs: 1,
    })).rejects.toThrow(/retry limit.*5/i);
  });
});

describe("iterateMission with spawn", () => {
  test("returns spawned when spawnCommand is provided", async () => {
    const missionPath = tmpPath("iter-spawn-m");
    const storePath = tmpPath("iter-spawn");
    const spawnsPath = tmpPath("iter-spawn-s");
    const mission = await createMission("spawn-iterate", {}, missionPath);
    const task = createTask("spawn iterate task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await iterateMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      spawnCommand: ["echo", "processing"],
      spawnsPath,
    });
    expect(result).toBe("spawned");
  });

  test("returns idle when no tasks with spawnCommand", async () => {
    const missionPath = tmpPath("iter-spawn-idle-m");
    const storePath = tmpPath("iter-spawn-idle");
    const mission = await createMission("idle-spawn", {}, missionPath);
    const queue = new TaskQueue(storePath);
    await queue.save();

    const result = await iterateMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      spawnCommand: ["echo"],
    });
    expect(result).toBe("idle");
  });

  test("returns mission_completed with spawnCommand", async () => {
    const missionPath = tmpPath("iter-spawn-done-m");
    const storePath = tmpPath("iter-spawn-done");
    const mission = await createMission("done-spawn", {}, missionPath);
    await completeMission(mission.id, missionPath);

    const result = await iterateMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      spawnCommand: ["echo"],
    });
    expect(result).toBe("mission_completed");
  });

  test("waits for spawn completion before returning", async () => {
    const missionPath = tmpPath("iter-spawn-wait-m");
    const storePath = tmpPath("iter-spawn-wait");
    const spawnsPath = tmpPath("iter-spawn-wait-s");
    const mission = await createMission("spawn-wait", {}, missionPath);
    const task = createTask("spawn wait task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await iterateMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      spawnCommand: ["sh", "-c", "sleep 0.1 && echo done"],
      spawnsPath,
    });
    expect(result).toBe("spawned");

    // After iterateMission returns, the task must already be done (not in-progress)
    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.owner).toBeUndefined();
  });

  test("processes tasks sequentially not in parallel with spawnCommand", async () => {
    const missionPath = tmpPath("iter-spawn-seq-m");
    const storePath = tmpPath("iter-spawn-seq");
    const spawnsPath = tmpPath("iter-spawn-seq-s");
    const mission = await createMission("spawn-seq", {}, missionPath);
    const task1 = createTask("seq task 1");
    const task2 = createTask("seq task 2");
    await setupQueue(storePath, [
      { ...task1, missionId: mission.id },
      { ...task2, missionId: mission.id },
    ]);

    // First iteration: spawns and completes task1
    const result1 = await iterateMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      spawnCommand: ["echo", "ok"],
      spawnsPath,
    });
    expect(result1).toBe("spawned");

    const tasksAfter1 = await load(storePath);
    const t1 = tasksAfter1.find(t => t.id === task1.id);
    expect(t1?.status).toBe("done");
    // task2 should still be observing (not yet spawned)
    const t2 = tasksAfter1.find(t => t.id === task2.id);
    expect(t2?.status).toBe("observing");

    // Second iteration: spawns and completes task2
    const result2 = await iterateMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      spawnCommand: ["echo", "ok"],
      spawnsPath,
    });
    expect(result2).toBe("spawned");

    const tasksAfter2 = await load(storePath);
    const t2After = tasksAfter2.find(t => t.id === task2.id);
    expect(t2After?.status).toBe("done");
  });

  test("still processes plan tasks inline with spawnCommand", async () => {
    const missionPath = tmpPath("iter-spawn-plan-m");
    const storePath = tmpPath("iter-spawn-plan");
    const mission = await createMission("plan-spawn", {}, missionPath);
    const task = createTask("plan with spawn");
    const planTask = {
      ...task,
      missionId: mission.id,
      context: { plan: true, subtasks: ["child1"] },
    };
    await setupQueue(storePath, [planTask]);

    const result = await iterateMission(mission.id, {
      storePath,
      missionsPath: missionPath,
      spawnCommand: ["echo", "should not run"],
    });
    expect(result).toBe("processed");

    const tasks = await load(storePath);
    const parent = tasks.find(t => t.id === task.id);
    expect(parent?.status).toBe("done");
    const children = tasks.filter(t => t.id !== task.id);
    expect(children).toHaveLength(1);
  });
});

describe("processTask auto-complete", () => {
  test("auto-completes mission when last task finishes", async () => {
    const storePath = tmpPath("pt-autocomplete");
    const missionPath = tmpPath("pt-autocomplete-m");
    const mission = await createMissionWithPrinciple("auto-pt", missionPath);
    const task = createTask("last task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["echo", "ok"], missionsPath: missionPath });

    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("completed");
  });

  test("does not auto-complete when other tasks remain pending", async () => {
    const storePath = tmpPath("pt-no-autocomplete");
    const missionPath = tmpPath("pt-no-autocomplete-m");
    const mission = await createMissionWithPrinciple("partial-pt", missionPath);
    const task1 = createTask("first");
    const task2 = createTask("second");
    await setupQueue(storePath, [
      { ...task1, missionId: mission.id },
      { ...task2, missionId: mission.id },
    ]);

    await processTask(task1, mission, { storePath, actCommand: ["echo", "ok"], missionsPath: missionPath });

    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("active");
  });

  test("fails mission when last task fails", async () => {
    const storePath = tmpPath("pt-autocomplete-fail");
    const missionPath = tmpPath("pt-autocomplete-fail-m");
    const mission = await createMissionWithPrinciple("auto-fail-pt", missionPath);
    const task = createTask("will fail", { retryCount: 2 });
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["sh", "-c", "exit 1"], missionsPath: missionPath });

    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("failed");
  });
});

describe("processTask retry with backoff", () => {
  test("resets to observing with retryCount incremented on first failure", async () => {
    const storePath = tmpPath("retry-first");
    const missionPath = tmpPath("retry-first-m");
    const mission = await createMissionWithPrinciple("retry-first", missionPath);
    const task = createTask("will fail once");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["sh", "-c", "exit 1"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("observing");
    expect(updated?.context.retryCount).toBe(1);
    expect(updated?.owner).toBeUndefined();
  });

  test("increments retryCount on second failure", async () => {
    const storePath = tmpPath("retry-second");
    const missionPath = tmpPath("retry-second-m");
    const mission = await createMissionWithPrinciple("retry-second", missionPath);
    const task = createTask("fail twice", { retryCount: 1 });
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["sh", "-c", "exit 1"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("observing");
    expect(updated?.context.retryCount).toBe(2);
  });

  test("stays failed when retryCount reaches max (2)", async () => {
    const storePath = tmpPath("retry-max");
    const missionPath = tmpPath("retry-max-m");
    const mission = await createMissionWithPrinciple("retry-max", missionPath);
    const task = createTask("exhausted retries", { retryCount: 2 });
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["sh", "-c", "exit 1"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.context.retryCount).toBe(2);
  });

  test("retries on exception in catch path", async () => {
    const storePath = tmpPath("retry-exc");
    const missionPath = tmpPath("retry-exc-m");
    const mission = await createMissionWithPrinciple("retry-exc", missionPath);
    const task = createTask("exception task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["__nonexistent_cmd_xyz__"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("observing");
    expect(updated?.context.retryCount).toBe(1);
  });

  test("logs [RETRY] with attempt info", async () => {
    const storePath = tmpPath("retry-log");
    const missionPath = tmpPath("retry-log-m");
    const mission = await createMissionWithPrinciple("retry-log", missionPath);
    const task = createTask("retry logged");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["sh", "-c", "exit 1"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    const retryLog = updated?.logs.find(l => l.content.includes("[RETRY]"));
    expect(retryLog).toBeDefined();
    expect(retryLog?.content).toContain("1/2");
  });

  test("sets retryAfter with 1s backoff on first failure", async () => {
    const storePath = tmpPath("retry-after1");
    const missionPath = tmpPath("retry-after1-m");
    const mission = await createMissionWithPrinciple("retry-after1", missionPath);
    const task = createTask("backoff 1s");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const before = Date.now();
    await processTask(task, mission, { storePath, actCommand: ["sh", "-c", "exit 1"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    const retryAfter = new Date(updated?.context.retryAfter as string).getTime();
    expect(retryAfter).toBeGreaterThanOrEqual(before + 800);
    expect(retryAfter).toBeLessThanOrEqual(before + 1500);
  });

  test("sets retryAfter with 2s backoff on second failure", async () => {
    const storePath = tmpPath("retry-after2");
    const missionPath = tmpPath("retry-after2-m");
    const mission = await createMissionWithPrinciple("retry-after2", missionPath);
    const task = createTask("backoff 2s", { retryCount: 1 });
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const before = Date.now();
    await processTask(task, mission, { storePath, actCommand: ["sh", "-c", "exit 1"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    const retryAfter = new Date(updated?.context.retryAfter as string).getTime();
    expect(retryAfter).toBeGreaterThanOrEqual(before + 1800);
    expect(retryAfter).toBeLessThanOrEqual(before + 2500);
  });

  test("spawnTask resets to observing on failure when retryCount < 2", async () => {
    const storePath = tmpPath("spawn-retry");
    const missionPath = tmpPath("spawn-retry-m");
    const spawnsPath = tmpPath("spawn-retry-s");
    const mission = await createMission("spawn-retry", {}, missionPath);
    const task = createTask("spawn fail");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await spawnTask(task, mission, ["sh", "-c", "exit 1"], { storePath, spawnsPath });
    await result.completion;

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("observing");
    expect(updated?.context.retryCount).toBe(1);
    expect(updated?.owner).toBeUndefined();
  });

  test("spawnTask stays failed when retryCount >= 2", async () => {
    const storePath = tmpPath("spawn-retry-max");
    const missionPath = tmpPath("spawn-retry-max-m");
    const spawnsPath = tmpPath("spawn-retry-max-s");
    const mission = await createMission("spawn-retry-max", {}, missionPath);
    const task = createTask("spawn exhaust", { retryCount: 2 });
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await spawnTask(task, mission, ["sh", "-c", "exit 1"], { storePath, spawnsPath });
    await result.completion;

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("failed");
  });

  test("findNextMissionTask skips tasks with future retryAfter", () => {
    const queue = new TaskQueue();
    const missionId = crypto.randomUUID();
    const task = createTask("retrying");
    queue.enqueue(task);
    queue.update(task.id, {
      missionId,
      context: { retryCount: 1, retryAfter: new Date(Date.now() + 60000).toISOString() },
    });

    const result = findNextMissionTask(queue, missionId);
    expect(result).toBeUndefined();
  });

  test("findNextMissionTask picks up tasks with past retryAfter", () => {
    const queue = new TaskQueue();
    const missionId = crypto.randomUUID();
    const task = createTask("ready to retry");
    queue.enqueue(task);
    queue.update(task.id, {
      missionId,
      context: { retryCount: 1, retryAfter: new Date(Date.now() - 1000).toISOString() },
    });

    const result = findNextMissionTask(queue, missionId);
    expect(result?.id).toBe(task.id);
  });
});

describe("orientTask", () => {
  test("records applicable principles in orient log when principles exist", async () => {
    const storePath = tmpPath("orient-principles");
    const missionPath = tmpPath("orient-principles-m");
    const mission = await createMission("orient-p", {}, missionPath);
    await addMissionPrinciple(mission.id, "Write tests first", missionPath);
    await addMissionPrinciple(mission.id, "Keep changes small", missionPath);
    const missions = await loadMissions(missionPath);
    const updatedMission = missions[0];

    const task = createTask("implement feature");
    await setupQueue(storePath, [{ ...task, missionId: updatedMission.id }]);

    const result = await orientTask(task.id, updatedMission, storePath);
    expect(result).toBe("oriented");

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("orienting");
    const orientLog = updated?.logs.find(l => l.phase === "orient");
    expect(orientLog?.content).toContain("Write tests first");
    expect(orientLog?.content).toContain("Keep changes small");
  });

  test("transitions to waiting_human when no principles are defined", async () => {
    const storePath = tmpPath("orient-no-principles");
    const missionPath = tmpPath("orient-no-principles-m");
    const mission = await createMission("orient-empty", {}, missionPath);

    const task = createTask("task without guidance");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await orientTask(task.id, mission, storePath);
    expect(result).toBe("escalated");

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("waiting_human");
    const orientLog = updated?.logs.find(l => l.phase === "orient");
    expect(orientLog?.content).toContain(HUMAN_REQUIRED_PREFIX);
  });

  test("orient log includes mission name", async () => {
    const storePath = tmpPath("orient-mission-name");
    const missionPath = tmpPath("orient-mission-name-m");
    const mission = await createMission("my-named-mission", {}, missionPath);
    await addMissionPrinciple(mission.id, "Be thorough", missionPath);
    const missions = await loadMissions(missionPath);
    const updatedMission = missions[0];

    const task = createTask("named mission task");
    await setupQueue(storePath, [{ ...task, missionId: updatedMission.id }]);

    await orientTask(task.id, updatedMission, storePath);

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    const orientLog = updated?.logs.find(l => l.phase === "orient");
    expect(orientLog?.content).toContain("my-named-mission");
  });
});

describe("shouldForceEscalation", () => {
  function makeDoneTask(missionId: string, hadEscalation: boolean): ReturnType<typeof createTask> {
    const task = createTask("done task");
    task.status = "done";
    task.missionId = missionId;
    if (hadEscalation) {
      task.logs.push({ phase: "orient", content: `${HUMAN_REQUIRED_PREFIX}question`, timestamp: new Date().toISOString() });
    }
    return task;
  }

  test("returns false when fewer completed tasks than window", () => {
    const missionId = crypto.randomUUID();
    const tasks = Array.from({ length: ORIENT_ESCALATION_WINDOW - 1 }, () => makeDoneTask(missionId, false));
    expect(shouldForceEscalation(tasks)).toBe(false);
  });

  test("returns false when no completed tasks exist (new mission)", () => {
    expect(shouldForceEscalation([])).toBe(false);
  });

  test("returns true when all recent tasks lack human escalation", () => {
    const missionId = crypto.randomUUID();
    const tasks = Array.from({ length: ORIENT_ESCALATION_WINDOW }, () => makeDoneTask(missionId, false));
    expect(shouldForceEscalation(tasks)).toBe(true);
  });

  test("returns false when at least one recent task had human escalation", () => {
    const missionId = crypto.randomUUID();
    const tasks = Array.from({ length: ORIENT_ESCALATION_WINDOW }, (_, i) =>
      makeDoneTask(missionId, i === 0));
    expect(shouldForceEscalation(tasks)).toBe(false);
  });

  test("only considers most recent tasks within window", () => {
    const missionId = crypto.randomUUID();
    // Old escalated task outside window + recent non-escalated tasks filling the window
    const oldEscalated = makeDoneTask(missionId, true);
    oldEscalated.updatedAt = new Date("2020-01-01").toISOString();
    const recentTasks = Array.from({ length: ORIENT_ESCALATION_WINDOW }, () => {
      const t = makeDoneTask(missionId, false);
      t.updatedAt = new Date().toISOString();
      return t;
    });
    expect(shouldForceEscalation([...recentTasks, oldEscalated])).toBe(true);
  });

  test("returns false when all tasks are non-terminal", () => {
    const missionId = crypto.randomUUID();
    const tasks = Array.from({ length: ORIENT_ESCALATION_WINDOW + 3 }, () => {
      const t = makeDoneTask(missionId, false);
      t.status = "acting";
      return t;
    });
    expect(shouldForceEscalation(tasks)).toBe(false);
  });

  test("counts failed tasks as completed for escalation tracking", () => {
    const missionId = crypto.randomUUID();
    const tasks = Array.from({ length: ORIENT_ESCALATION_WINDOW }, () => {
      const t = makeDoneTask(missionId, false);
      t.status = "failed";
      return t;
    });
    expect(shouldForceEscalation(tasks)).toBe(true);
  });
});

describe("orientTask forced escalation", () => {
  test("forces escalation when recent tasks lack human involvement", async () => {
    const storePath = tmpPath("orient-force-escalate");
    const missionPath = tmpPath("orient-force-escalate-m");
    const mission = await createMission("force-esc", {}, missionPath);
    await addMissionPrinciple(mission.id, "Test first", missionPath);
    const missions = await loadMissions(missionPath);
    const updatedMission = missions[0];

    // Create completed tasks without escalation to fill the window
    const doneTasks = Array.from({ length: ORIENT_ESCALATION_WINDOW }, () => {
      const t = createTask("past task");
      t.missionId = updatedMission.id;
      t.status = "done" as const;
      t.updatedAt = new Date().toISOString();
      return t;
    });
    const newTask = createTask("new task");
    newTask.missionId = updatedMission.id;
    await setupQueue(storePath, [...doneTasks, newTask]);

    const result = await orientTask(newTask.id, updatedMission, storePath);
    expect(result).toBe("escalated");

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === newTask.id);
    expect(updated?.status).toBe("waiting_human");
    const orientLog = updated?.logs.find(l => l.phase === "orient");
    expect(orientLog?.content).toContain(HUMAN_REQUIRED_PREFIX);
  });

  test("proceeds normally when recent tasks include escalation", async () => {
    const storePath = tmpPath("orient-has-escalation");
    const missionPath = tmpPath("orient-has-escalation-m");
    const mission = await createMission("has-esc", {}, missionPath);
    await addMissionPrinciple(mission.id, "Test first", missionPath);
    const missions = await loadMissions(missionPath);
    const updatedMission = missions[0];

    // One task with escalation in the window
    const escalatedTask = createTask("escalated task");
    escalatedTask.missionId = updatedMission.id;
    escalatedTask.status = "done" as const;
    escalatedTask.logs.push({ phase: "orient" as const, content: `${HUMAN_REQUIRED_PREFIX}some question`, timestamp: new Date().toISOString() });

    const doneTasks = Array.from({ length: ORIENT_ESCALATION_WINDOW - 1 }, () => {
      const t = createTask("past task");
      t.missionId = updatedMission.id;
      t.status = "done" as const;
      return t;
    });
    const newTask = createTask("new task");
    newTask.missionId = updatedMission.id;
    await setupQueue(storePath, [escalatedTask, ...doneTasks, newTask]);

    const result = await orientTask(newTask.id, updatedMission, storePath);
    expect(result).toBe("oriented");
  });
});

describe("processTask orient integration", () => {
  test("escalates to waiting_human when mission has no principles", async () => {
    const storePath = tmpPath("process-no-principles");
    const missionPath = tmpPath("process-no-principles-m");
    const mission = await createMission("no-principles", {}, missionPath);
    const task = createTask("needs guidance");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["echo"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("waiting_human");
    const orientLog = updated?.logs.find(l => l.phase === "orient");
    expect(orientLog?.content).toContain(HUMAN_REQUIRED_PREFIX);
  });

  test("proceeds to done when mission has principles", async () => {
    const storePath = tmpPath("process-with-principles");
    const missionPath = tmpPath("process-with-principles-m");
    const mission = await createMission("with-principles", {}, missionPath);
    await addMissionPrinciple(mission.id, "Test first", missionPath);
    const missions = await loadMissions(missionPath);
    const principledMission = missions[0];

    const task = createTask("guided task");
    await setupQueue(storePath, [{ ...task, missionId: principledMission.id }]);

    await processTask(task, principledMission, { storePath, actCommand: ["echo"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
  });

  test("orient log records principles used for decision in processTask", async () => {
    const storePath = tmpPath("process-orient-log");
    const missionPath = tmpPath("process-orient-log-m");
    const mission = await createMission("orient-log-mission", {}, missionPath);
    await addMissionPrinciple(mission.id, "Incremental delivery", missionPath);
    const missions = await loadMissions(missionPath);
    const principledMission = missions[0];

    const task = createTask("orient logged task");
    await setupQueue(storePath, [{ ...task, missionId: principledMission.id }]);

    await processTask(task, principledMission, { storePath, actCommand: ["echo"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    const orientLog = updated?.logs.find(l => l.phase === "orient");
    expect(orientLog?.content).toContain("Incremental delivery");
  });
});

describe("processTask escalation via exit code", () => {
  test("sets WORQLOAD_TASK_ID in spawned subprocess environment", async () => {
    const storePath = tmpPath("process-env");
    const missionPath = tmpPath("process-env-m");
    const mission = await createMissionWithPrinciple("env-mission", missionPath);
    const task = createTask("env task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["sh", "-c", "echo $WORQLOAD_TASK_ID"] });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    const actLog = updated?.logs.find(l => l.phase === "act" && l.content.includes(task.id));
    expect(actLog).toBeDefined();
  });

  test("transitions to waiting_human on escalation exit code", async () => {
    const storePath = tmpPath("process-escalate");
    const missionPath = tmpPath("process-escalate-m");
    const mission = await createMissionWithPrinciple("escalate-mission", missionPath);
    const task = createTask("needs human input");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, {
      storePath,
      actCommand: ["sh", "-c", `echo "I need guidance"; exit ${ESCALATION_EXIT_CODE}`],
    });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("waiting_human");
    expect(updated?.owner).toBeUndefined();
    const orientLog = updated?.logs.find(l => l.phase === "orient" && l.content.includes(HUMAN_REQUIRED_PREFIX));
    expect(orientLog).toBeDefined();
  });

  test("escalation exit code does not retry", async () => {
    const storePath = tmpPath("process-escalate-no-retry");
    const missionPath = tmpPath("process-escalate-no-retry-m");
    const mission = await createMissionWithPrinciple("no-retry-mission", missionPath);
    const task = createTask("escalate no retry");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, {
      storePath,
      actCommand: ["sh", "-c", `exit ${ESCALATION_EXIT_CODE}`],
    });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("waiting_human");
    expect(updated?.context.retryCount).toBeUndefined();
  });
});

describe("spawn timeout", () => {
  test("processTask resets to observing on spawn timeout", async () => {
    const storePath = tmpPath("timeout-process");
    const missionPath = tmpPath("timeout-process-m");
    const mission = await createMissionWithPrinciple("timeout-proc", missionPath);
    const task = createTask("slow task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, {
      storePath,
      actCommand: ["sh", "-c", "sleep 10"],
      spawnTimeoutMs: 100,
    });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("observing");
    expect(updated?.context.retryCount).toBe(1);
    expect(updated?.owner).toBeUndefined();
    const timeoutLog = updated?.logs.find(l => l.content.includes("[TIMEOUT]"));
    expect(timeoutLog).toBeDefined();
  });

  test("processTask timeout respects retry exhaustion", async () => {
    const storePath = tmpPath("timeout-exhaust");
    const missionPath = tmpPath("timeout-exhaust-m");
    const mission = await createMissionWithPrinciple("timeout-exhaust", missionPath);
    const task = createTask("exhausted timeout", { retryCount: 2 });
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, {
      storePath,
      actCommand: ["sh", "-c", "sleep 10"],
      spawnTimeoutMs: 100,
    });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("failed");
  });

  test("processTask completes normally when within timeout", async () => {
    const storePath = tmpPath("timeout-ok");
    const missionPath = tmpPath("timeout-ok-m");
    const mission = await createMissionWithPrinciple("timeout-ok", missionPath);
    const task = createTask("fast task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, {
      storePath,
      actCommand: ["echo", "done quickly"],
      spawnTimeoutMs: 5000,
    });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
  });

  test("spawnTask resets to observing on spawn timeout", async () => {
    const storePath = tmpPath("timeout-spawn");
    const missionPath = tmpPath("timeout-spawn-m");
    const spawnsPath = tmpPath("timeout-spawn-s");
    const mission = await createMission("timeout-spawn", {}, missionPath);
    const task = createTask("slow spawn");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await spawnTask(task, mission, ["sh", "-c", "sleep 10"], {
      storePath,
      spawnsPath,
      spawnTimeoutMs: 100,
    });
    const completion = await result.completion;

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("observing");
    expect(updated?.context.retryCount).toBe(1);
    expect(updated?.owner).toBeUndefined();
    const timeoutLog = updated?.logs.find(l => l.content.includes("[TIMEOUT]"));
    expect(timeoutLog).toBeDefined();
  });

  test("spawnTask timeout respects retry exhaustion", async () => {
    const storePath = tmpPath("timeout-spawn-exhaust");
    const missionPath = tmpPath("timeout-spawn-exhaust-m");
    const spawnsPath = tmpPath("timeout-spawn-exhaust-s");
    const mission = await createMission("timeout-spawn-exhaust", {}, missionPath);
    const task = createTask("exhausted spawn timeout", { retryCount: 2 });
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await spawnTask(task, mission, ["sh", "-c", "sleep 10"], {
      storePath,
      spawnsPath,
      spawnTimeoutMs: 100,
    });
    await result.completion;

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("failed");
  });

  test("spawnTask completes normally when within timeout", async () => {
    const storePath = tmpPath("timeout-spawn-ok");
    const missionPath = tmpPath("timeout-spawn-ok-m");
    const spawnsPath = tmpPath("timeout-spawn-ok-s");
    const mission = await createMission("timeout-spawn-ok", {}, missionPath);
    const task = createTask("fast spawn");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await spawnTask(task, mission, ["echo", "quick"], {
      storePath,
      spawnsPath,
      spawnTimeoutMs: 5000,
    });
    const completion = await result.completion;
    expect(completion.exitCode).toBe(0);

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
  });

  test("default spawnTimeoutMs is 5 minutes", async () => {
    const storePath = tmpPath("timeout-default");
    const missionPath = tmpPath("timeout-default-m");
    const mission = await createMissionWithPrinciple("timeout-default", missionPath);
    const task = createTask("default timeout task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    // Process a fast task without specifying spawnTimeoutMs — should use default (5 min)
    // and complete normally since echo finishes well within 5 min
    await processTask(task, mission, {
      storePath,
      actCommand: ["echo", "ok"],
    });

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
  });
});

describe("ensureReportForDoneTask", () => {
  test("generates report from task logs when no report exists", async () => {
    const reportsPath = tmpPath("ensure-report-new");
    const task = createTask("completed task");
    task.status = "done";
    task.logs = [
      { phase: "observe", content: "Observed the task", timestamp: new Date().toISOString() },
      { phase: "orient", content: "Oriented against principles", timestamp: new Date().toISOString() },
      { phase: "decide", content: "Decided to proceed", timestamp: new Date().toISOString() },
      { phase: "act", content: "Executed successfully", timestamp: new Date().toISOString() },
    ];

    await ensureReportForDoneTask(task, "test-mission", { reportsPath });

    const reports = await loadReports(reportsPath);
    expect(reports).toHaveLength(1);
    expect(reports[0].taskId).toBe(task.id);
    expect(reports[0].title).toContain(task.title);
    expect(reports[0].createdBy).toBe("mission:test-mission");
    expect(reports[0].status).toBe("unread");
    expect(reports[0].content).toContain("Executed successfully");
  });

  test("skips report generation when report for task already exists", async () => {
    const reportsPath = tmpPath("ensure-report-exists");
    const task = createTask("already reported task");
    task.status = "done";
    task.logs = [
      { phase: "act", content: "Done", timestamp: new Date().toISOString() },
    ];

    await addReport(task.title, "Existing report", "agent", reportsPath);
    const existingReports = await loadReports(reportsPath);
    existingReports[0].taskId = task.id;
    const { saveReports } = await import("./reports");
    await saveReports(existingReports, reportsPath);

    await ensureReportForDoneTask(task, "test-mission", { reportsPath });

    const reports = await loadReports(reportsPath);
    expect(reports).toHaveLength(1);
    expect(reports[0].content).toBe("Existing report");
  });

  test("includes act phase logs in report content", async () => {
    const reportsPath = tmpPath("ensure-report-act");
    const task = createTask("act log task");
    task.status = "done";
    task.logs = [
      { phase: "observe", content: "Observed", timestamp: new Date().toISOString() },
      { phase: "act", content: "First action output", timestamp: new Date().toISOString() },
      { phase: "act", content: "Second action output", timestamp: new Date().toISOString() },
    ];

    await ensureReportForDoneTask(task, "my-mission", { reportsPath });

    const reports = await loadReports(reportsPath);
    expect(reports).toHaveLength(1);
    expect(reports[0].content).toContain("First action output");
    expect(reports[0].content).toContain("Second action output");
  });

  test("skips report generation when act logs lack substance", async () => {
    const reportsPath = tmpPath("ensure-report-vacuous");
    const task = createTask("vacuous act task");
    task.status = "done";
    task.logs = [
      { phase: "act", content: "done", timestamp: new Date().toISOString() },
    ];

    await ensureReportForDoneTask(task, "test-mission", { reportsPath });

    const reports = await loadReports(reportsPath);
    expect(reports).toHaveLength(0);
  });

  test("skips report generation when no act logs exist", async () => {
    const reportsPath = tmpPath("ensure-report-no-act");
    const task = createTask("no act log task");
    task.status = "done";
    task.logs = [
      { phase: "observe", content: "Observed", timestamp: new Date().toISOString() },
    ];

    await ensureReportForDoneTask(task, "test-mission", { reportsPath });

    const reports = await loadReports(reportsPath);
    expect(reports).toHaveLength(0);
  });
});

describe("processTask report generation", () => {
  test("generates report when task completes successfully", async () => {
    const storePath = tmpPath("report-gen");
    const missionPath = tmpPath("report-gen-m");
    const reportsPath = tmpPath("report-gen-r");
    const mission = await createMissionWithPrinciple("report-gen", missionPath);
    const task = createTask("report gen task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["echo", "task output"], reportsPath });

    const reports = await loadReports(reportsPath);
    expect(reports).toHaveLength(1);
    expect(reports[0].taskId).toBe(task.id);
    expect(reports[0].createdBy).toBe(`mission:${mission.name}`);
  });

  test("does not generate report when task fails", async () => {
    const storePath = tmpPath("report-fail");
    const missionPath = tmpPath("report-fail-m");
    const reportsPath = tmpPath("report-fail-r");
    const mission = await createMissionWithPrinciple("report-fail", missionPath);
    const task = createTask("failing task", { retryCount: 2 });
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    await processTask(task, mission, { storePath, actCommand: ["sh", "-c", "exit 1"], reportsPath });

    const reports = await loadReports(reportsPath);
    expect(reports).toHaveLength(0);
  });
});

describe.skip("worktree fallback on spawn failure", () => {
  test("sets worktreeDisabled in context when worktree spawn fails", async () => {
    const storePath = tmpPath("wt-fallback");
    const missionPath = tmpPath("wt-fallback-m");
    const mission = await createMissionWithPrinciple("wt-fallback", missionPath);
    const task = createTask("worktree fail task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      // useWorktree=true but actCommand fails — task should retry with worktreeDisabled
      await processTask(task, mission, {
        storePath,
        actCommand: ["sh", "-c", "exit 1"],
        useWorktree: true,
      });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("observing");
    expect(updated?.context.worktreeDisabled).toBe(true);
  });

  test("skips worktree creation when worktreeDisabled is set in context", async () => {
    const storePath = tmpPath("wt-disabled");
    const missionPath = tmpPath("wt-disabled-m");
    const mission = await createMissionWithPrinciple("wt-disabled", missionPath);
    // Task already has worktreeDisabled from a previous failed worktree attempt
    const task = createTask("retry without wt", { retryCount: 1, worktreeDisabled: true });
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await processTask(task, mission, {
        storePath,
        actCommand: ["sh", "-c", "echo no-worktree; exit 0"],
        useWorktree: true,
      });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
    // Spawn log should NOT mention "worktree:" since worktree was skipped
    const actLogs = updated?.logs.filter(l => l.phase === "act") ?? [];
    const spawnLog = actLogs.find(l => l.content.includes("Spawning:"));
    expect(spawnLog?.content).not.toContain("worktree:");
  });

  test("does not set worktreeDisabled when spawn succeeds with worktree", async () => {
    const storePath = tmpPath("wt-success");
    const missionPath = tmpPath("wt-success-m");
    const mission = await createMissionWithPrinciple("wt-success", missionPath);
    const task = createTask("worktree success task");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await processTask(task, mission, {
        storePath,
        actCommand: ["sh", "-c", "echo ok; exit 0"],
        useWorktree: true,
      });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.context.worktreeDisabled).toBeUndefined();
  });
});
