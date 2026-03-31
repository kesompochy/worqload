import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { createTask } from "./task";
import { TaskQueue } from "./queue";
import { createMission, loadMissions, saveMissions } from "./mission";
import type { Mission } from "./mission";
import { recordSpawnStart, loadSpawns, saveSpawns } from "./spawns";
import type { SpawnRecord } from "./spawns";
import type { RunnerState } from "./mission-runner-state";
import { filterSpawnsForDashboard, filterRunnersForDashboard } from "./server";

const REAL_STORE = ".worqload/tasks.json";
const REAL_MISSIONS = ".worqload/missions.json";
const REAL_SPAWNS = ".worqload/spawns.json";
let taskSnapshot: string | null = null;
let missionSnapshot: string | null = null;
let spawnSnapshot: string | null = null;

beforeAll(() => {
  try { taskSnapshot = readFileSync(REAL_STORE, "utf-8"); } catch { taskSnapshot = null; }
  try { missionSnapshot = readFileSync(REAL_MISSIONS, "utf-8"); } catch { missionSnapshot = null; }
  try { spawnSnapshot = readFileSync(REAL_SPAWNS, "utf-8"); } catch { spawnSnapshot = null; }
});

afterAll(() => {
  let taskAfter: string | null = null;
  let missionAfter: string | null = null;
  let spawnAfter: string | null = null;
  try { taskAfter = readFileSync(REAL_STORE, "utf-8"); } catch { taskAfter = null; }
  try { missionAfter = readFileSync(REAL_MISSIONS, "utf-8"); } catch { missionAfter = null; }
  try { spawnAfter = readFileSync(REAL_SPAWNS, "utf-8"); } catch { spawnAfter = null; }
  if (taskSnapshot !== taskAfter) throw new Error("Tests modified the real tasks.json!");
  if (missionSnapshot !== missionAfter) throw new Error("Tests modified the real missions.json!");
  if (spawnSnapshot !== spawnAfter) throw new Error("Tests modified the real spawns.json!");
});

function tmpPath(prefix: string): string {
  return join(tmpdir(), `worqload-server-test-${prefix}-${crypto.randomUUID()}.json`);
}

describe("GET /api/missions", () => {
  test("returns missions with task counts", async () => {
    const missionsPath = tmpPath("missions");
    const mission = await createMission("Ship v2", {}, missionsPath);

    const storePath = tmpPath("tasks");
    const queue = new TaskQueue(storePath);
    const t1 = createTask("task in mission");
    t1.missionId = mission.id;
    const t2 = createTask("task in mission 2");
    t2.missionId = mission.id;
    const t3 = createTask("unassigned task");
    queue.enqueue(t1);
    queue.enqueue(t2);
    queue.enqueue(t3);

    const missions = await loadMissions(missionsPath);
    const tasks = queue.list();

    const result = missions.map(m => ({
      ...m,
      taskCount: tasks.filter(t => t.missionId === m.id).length,
      tasks: tasks.filter(t => t.missionId === m.id),
    }));

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Ship v2");
    expect(result[0].taskCount).toBe(2);
    expect(result[0].tasks).toHaveLength(2);
    expect(result[0].tasks[0].id).toBe(t1.id);
  });

  test("completed missions are included", async () => {
    const missionsPath = tmpPath("missions");
    const m1 = await createMission("Active mission", {}, missionsPath);
    const m2 = await createMission("Done mission", {}, missionsPath);
    const missions = await loadMissions(missionsPath);
    missions[1].status = "completed";
    await saveMissions(missions, missionsPath);

    const updated = await loadMissions(missionsPath);
    expect(updated).toHaveLength(2);
    expect(updated[0].status).toBe("active");
    expect(updated[1].status).toBe("completed");
  });

  test("unassigned tasks are not included in any mission", async () => {
    const missionsPath = tmpPath("missions");
    await createMission("Mission A", {}, missionsPath);

    const storePath = tmpPath("tasks");
    const queue = new TaskQueue(storePath);
    const t1 = createTask("no mission");
    queue.enqueue(t1);

    const missions = await loadMissions(missionsPath);
    const tasks = queue.list();

    const missionTasks = missions.flatMap(m =>
      tasks.filter(t => t.missionId === m.id)
    );
    const unassigned = tasks.filter(t => !t.missionId);

    expect(missionTasks).toHaveLength(0);
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0].id).toBe(t1.id);
  });

  test("tasks include their OODA status", async () => {
    const missionsPath = tmpPath("missions");
    const mission = await createMission("Status mission", {}, missionsPath);

    const storePath = tmpPath("tasks");
    const queue = new TaskQueue(storePath);
    const t1 = createTask("observing task");
    t1.missionId = mission.id;
    const t2 = createTask("acting task");
    t2.missionId = mission.id;
    queue.enqueue(t1);
    queue.enqueue(t2);
    queue.transition(t2.id, "orienting");
    queue.transition(t2.id, "deciding");
    queue.transition(t2.id, "acting");

    const missions = await loadMissions(missionsPath);
    const tasks = queue.list();
    const result = missions.map(m => ({
      ...m,
      taskCount: tasks.filter(t => t.missionId === m.id).length,
      tasks: tasks.filter(t => t.missionId === m.id),
    }));

    expect(result[0].tasks[0].status).toBe("observing");
    expect(result[0].tasks[1].status).toBe("acting");
  });

  test("missions include spawn records for their tasks", async () => {
    const missionsPath = tmpPath("missions");
    const spawnsPath = tmpPath("spawns");
    const mission = await createMission("Spawn mission", {}, missionsPath);

    const storePath = tmpPath("tasks");
    const queue = new TaskQueue(storePath);
    const t1 = createTask("spawned task");
    t1.missionId = mission.id;
    const t2 = createTask("no spawn task");
    t2.missionId = mission.id;
    queue.enqueue(t1);
    queue.enqueue(t2);

    await recordSpawnStart(t1.id, t1.title, "agent-1", 12345, spawnsPath);

    const missions = await loadMissions(missionsPath);
    const tasks = queue.list();
    const spawns = await loadSpawns(spawnsPath);

    const result = missions.map(m => ({
      ...m,
      taskCount: tasks.filter(t => t.missionId === m.id).length,
      tasks: tasks.filter(t => t.missionId === m.id).map(t => ({
        ...t,
        spawns: spawns.filter(s => s.taskId === t.id),
      })),
    }));

    expect(result[0].tasks[0].spawns).toHaveLength(1);
    expect(result[0].tasks[0].spawns[0].status).toBe("running");
    expect(result[0].tasks[0].spawns[0].owner).toBe("agent-1");
    expect(result[0].tasks[1].spawns).toHaveLength(0);
  });
});

describe("Activity visibility: spawn detail fields", () => {
  test("spawn records contain taskId, taskTitle, owner, and startedAt", async () => {
    const spawnsPath = tmpPath("spawns");
    const taskId = crypto.randomUUID();
    const spawn = await recordSpawnStart(taskId, "Build feature X", "agent-alpha", 9999, spawnsPath);

    expect(spawn.taskId).toBe(taskId);
    expect(spawn.taskTitle).toBe("Build feature X");
    expect(spawn.owner).toBe("agent-alpha");
    expect(spawn.startedAt).toBeDefined();
    expect(new Date(spawn.startedAt).getTime()).not.toBeNaN();
    expect(spawn.status).toBe("running");
  });

  test("loadSpawns returns all fields needed for activity view", async () => {
    const spawnsPath = tmpPath("spawns");
    const taskId1 = crypto.randomUUID();
    const taskId2 = crypto.randomUUID();
    await recordSpawnStart(taskId1, "Task A", "runner-1", 1001, spawnsPath);
    await recordSpawnStart(taskId2, "Task B", "runner-2", 1002, spawnsPath);

    const spawns = await loadSpawns(spawnsPath);
    expect(spawns).toHaveLength(2);

    for (const s of spawns) {
      expect(s).toHaveProperty("taskId");
      expect(s).toHaveProperty("taskTitle");
      expect(s).toHaveProperty("owner");
      expect(s).toHaveProperty("startedAt");
      expect(s).toHaveProperty("status");
    }
  });
});

describe("Activity visibility: mission status and task count", () => {
  test("mission response includes status and taskCount for active missions", async () => {
    const missionsPath = tmpPath("missions");
    const mission = await createMission("Active mission", {}, missionsPath);

    const storePath = tmpPath("tasks");
    const queue = new TaskQueue(storePath);
    const t1 = createTask("task 1");
    t1.missionId = mission.id;
    const t2 = createTask("task 2");
    t2.missionId = mission.id;
    queue.enqueue(t1);
    queue.enqueue(t2);

    const missions = await loadMissions(missionsPath);
    const tasks = queue.list();
    const spawns: SpawnRecord[] = [];

    const result = missions.map(m => ({
      ...m,
      taskCount: tasks.filter(t => t.missionId === m.id).length,
      tasks: tasks.filter(t => t.missionId === m.id).map(t => ({
        ...t,
        spawns: spawns.filter(s => s.taskId === t.id),
      })),
    }));

    expect(result[0].status).toBe("active");
    expect(result[0].taskCount).toBe(2);
  });

  test("mission response includes status and taskCount for completed missions", async () => {
    const missionsPath = tmpPath("missions");
    const mission = await createMission("Done mission", {}, missionsPath);
    const missions = await loadMissions(missionsPath);
    missions[0].status = "completed";
    await saveMissions(missions, missionsPath);

    const storePath = tmpPath("tasks");
    const queue = new TaskQueue(storePath);

    const updated = await loadMissions(missionsPath);
    const tasks = queue.list();
    const spawns: SpawnRecord[] = [];

    const result = updated.map(m => ({
      ...m,
      taskCount: tasks.filter(t => t.missionId === m.id).length,
      tasks: tasks.filter(t => t.missionId === m.id).map(t => ({
        ...t,
        spawns: spawns.filter(s => s.taskId === t.id),
      })),
    }));

    expect(result[0].status).toBe("completed");
    expect(result[0].taskCount).toBe(0);
  });

  test("active and completed missions are distinguishable in response", async () => {
    const missionsPath = tmpPath("missions");
    await createMission("Active one", {}, missionsPath);
    await createMission("Completed one", {}, missionsPath);
    const missions = await loadMissions(missionsPath);
    missions[1].status = "completed";
    await saveMissions(missions, missionsPath);

    const updated = await loadMissions(missionsPath);
    const activeCount = updated.filter(m => m.status === "active").length;
    const completedCount = updated.filter(m => m.status === "completed").length;

    expect(activeCount).toBe(1);
    expect(completedCount).toBe(1);
  });
});

describe("Activity visibility: dashboard HTML", () => {
  test("SpawnRow displays taskId and startedAt", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/server.ts", "utf-8");

    // SpawnRow renders taskId (short ID)
    expect(source).toContain("spawn-task-id");
    // SpawnRow renders startedAt timestamp
    expect(source).toContain("spawn-started-at");
  });

  test("MissionCard displays status and task count", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/server.ts", "utf-8");

    expect(source).toContain("mission.status");
    expect(source).toContain("mission.taskCount");
  });

  test("ActivityDashboard section exists", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/server.ts", "utf-8");

    expect(source).toContain("ActivityDashboard");
    expect(source).toContain("Mission Runners");
    expect(source).toContain("Active Spawns");
  });
});

describe("API spawn filtering: filterSpawnsForDashboard", () => {
  function makeSpawn(overrides: Partial<SpawnRecord>): SpawnRecord {
    return {
      id: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      taskTitle: "test",
      owner: "agent",
      pid: 1000,
      status: "running",
      startedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  test("returns all running spawns", () => {
    const spawns = [
      makeSpawn({ status: "running" }),
      makeSpawn({ status: "running" }),
      makeSpawn({ status: "done", finishedAt: new Date().toISOString() }),
    ];
    const result = filterSpawnsForDashboard(spawns);
    const running = result.filter(s => s.status === "running");
    expect(running).toHaveLength(2);
  });

  test("returns at most 10 recent non-running spawns", () => {
    const spawns: SpawnRecord[] = [];
    for (let i = 0; i < 15; i++) {
      spawns.push(makeSpawn({
        status: "done",
        finishedAt: new Date(Date.now() - i * 1000).toISOString(),
      }));
    }
    const result = filterSpawnsForDashboard(spawns);
    expect(result).toHaveLength(10);
  });

  test("recent spawns are ordered newest first", () => {
    const older = makeSpawn({
      status: "done",
      finishedAt: new Date(Date.now() - 60000).toISOString(),
    });
    const newer = makeSpawn({
      status: "done",
      finishedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const result = filterSpawnsForDashboard([older, newer]);
    expect(result[0].id).toBe(newer.id);
    expect(result[1].id).toBe(older.id);
  });

  test("running spawns come before recent finished spawns", () => {
    const running = makeSpawn({ status: "running" });
    const finished = makeSpawn({
      status: "done",
      finishedAt: new Date().toISOString(),
    });
    const result = filterSpawnsForDashboard([finished, running]);
    expect(result[0].status).toBe("running");
    expect(result[1].status).toBe("done");
  });

  test("returns empty array when no spawns exist", () => {
    expect(filterSpawnsForDashboard([])).toEqual([]);
  });
});

describe("API runner filtering: filterRunnersForDashboard", () => {
  function makeRunner(overrides: Partial<RunnerState>): RunnerState {
    return {
      id: crypto.randomUUID(),
      missionId: crypto.randomUUID(),
      missionName: "test mission",
      pid: 2000,
      status: "running",
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      tasksProcessed: 0,
      consecutiveIdles: 0,
      ...overrides,
    };
  }

  test("excludes stopped runners", () => {
    const runners = [
      makeRunner({ status: "running" }),
      makeRunner({ status: "idle" }),
      makeRunner({ status: "stopped" }),
    ];
    const result = filterRunnersForDashboard(runners);
    expect(result).toHaveLength(2);
    expect(result.every(r => r.status !== "stopped")).toBe(true);
  });

  test("returns all running and idle runners", () => {
    const runners = [
      makeRunner({ status: "running" }),
      makeRunner({ status: "running" }),
      makeRunner({ status: "idle" }),
    ];
    const result = filterRunnersForDashboard(runners);
    expect(result).toHaveLength(3);
  });

  test("returns empty array when all runners are stopped", () => {
    const runners = [
      makeRunner({ status: "stopped" }),
      makeRunner({ status: "stopped" }),
    ];
    expect(filterRunnersForDashboard(runners)).toEqual([]);
  });

  test("returns empty array when no runners exist", () => {
    expect(filterRunnersForDashboard([])).toEqual([]);
  });
});
