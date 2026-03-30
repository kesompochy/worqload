import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { createTask } from "./task";
import { TaskQueue } from "./queue";
import { createMission, completeMission, addMissionPrinciple, loadMissions, type Mission } from "./mission";
import { findNextMissionTask, processTask, processPlanTask, iterateMission, spawnTask, runMission } from "./mission-runner";
import { load } from "./store";
import { loadSpawns } from "./spawns";

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

describe("iterateMission", () => {
  test("returns mission_completed when mission is completed", async () => {
    const missionPath = tmpPath("iter-completed-m");
    const storePath = tmpPath("iter-completed");
    const mission = await createMission("completed", {}, missionPath);
    await completeMission(mission.id, missionPath);

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath });
    expect(result).toBe("mission_completed");
  });

  test("returns idle when no tasks available", async () => {
    const missionPath = tmpPath("iter-idle-m");
    const storePath = tmpPath("iter-idle");
    const mission = await createMission("idle-mission", {}, missionPath);
    const queue = new TaskQueue(storePath);
    await queue.save();

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath });
    expect(result).toBe("idle");
  });

  test("returns processed after processing a task", async () => {
    const missionPath = tmpPath("iter-process-m");
    const storePath = tmpPath("iter-process");
    const mission = await createMission("process-mission", {}, missionPath);
    const task = createTask("to process");
    await setupQueue(storePath, [{ ...task, missionId: mission.id }]);

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath });
    expect(result).toBe("processed");

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
  });

  test("throws for non-existent mission", async () => {
    const missionPath = tmpPath("iter-notfound-m");
    const storePath = tmpPath("iter-notfound");

    expect(iterateMission("nonexistent", { storePath, missionsPath: missionPath }))
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

    const result1 = await iterateMission(mission.id, { storePath, missionsPath: missionPath });
    expect(result1).toBe("processed");

    const result2 = await iterateMission(mission.id, { storePath, missionsPath: missionPath });
    expect(result2).toBe("processed");

    // All tasks done → auto-complete triggers
    const result3 = await iterateMission(mission.id, { storePath, missionsPath: missionPath });
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

    const result = await iterateMission(mission.id.slice(0, 8), { storePath, missionsPath: missionPath });
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

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath });
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
    const task = createTask("fail me");
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
    const mission = await createMission("auto-done", {}, missionPath);
    const task1 = createTask("task 1");
    const task2 = createTask("task 2");
    await setupQueue(storePath, [
      { ...task1, missionId: mission.id },
      { ...task2, missionId: mission.id },
    ]);

    await iterateMission(mission.id, { storePath, missionsPath: missionPath });
    await iterateMission(mission.id, { storePath, missionsPath: missionPath });

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath });
    expect(result).toBe("mission_completed");

    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("completed");
  });

  test("auto-completes mission when all tasks are failed", async () => {
    const missionPath = tmpPath("auto-fail-m");
    const storePath = tmpPath("auto-fail");
    const mission = await createMission("auto-fail", {}, missionPath);
    const task = createTask("will fail");
    const queue = new TaskQueue(storePath);
    queue.enqueue({ ...task, missionId: mission.id });
    queue.transition(task.id, "failed");
    await queue.save();

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath });
    expect(result).toBe("mission_completed");

    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("completed");
  });

  test("auto-completes with mix of done and failed tasks", async () => {
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

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath });
    expect(result).toBe("mission_completed");
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

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath });
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

    const result = await iterateMission(mission.id, { storePath, missionsPath: missionPath });
    expect(result).toBe("idle");

    const missions = await loadMissions(missionPath);
    expect(missions[0].status).toBe("active");
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
      maxRetries: 2,
      retryBaseMs: 1,
      pollIntervalMs: 10,
      idleTimeoutMs: 500,
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
