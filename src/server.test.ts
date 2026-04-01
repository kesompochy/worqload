import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { createTask } from "./task";
import { TaskQueue } from "./queue";
import { createMission, loadMissions, saveMissions, completeMission, archiveMissions, loadMissionArchive } from "./mission";
import type { Mission } from "./mission";
import { recordSpawnStart, loadSpawns, saveSpawns } from "./spawns";
import { addFeedback } from "./feedback";
import { registerProject } from "./projects";
import type { Project } from "./projects";
import type { SpawnRecord } from "./spawns";
import type { RunnerState } from "./mission-runner-state";
import { filterSpawnsForDashboard, filterRunnersForDashboard, buildProjectsSummary, loadAllProjectFeedback, matchRoute } from "./server";
import type { Route } from "./server";

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

describe("EditableText: shared editable component with blur-to-save", () => {
  test("EditableText component is defined with onBlur save and Escape cancel", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/server.ts", "utf-8");

    const start = source.indexOf("function EditableText(");
    expect(start).toBeGreaterThan(-1);

    const nextFunc = source.indexOf("\nfunction ", start + 1);
    const body = source.slice(start, nextFunc > -1 ? nextFunc : undefined);
    expect(body).toContain("onBlur");
    expect(body).toContain("Escape");
    expect(body).toContain("onSave");
  });

  test("Principles uses EditableText instead of manual editingIndex state", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/server.ts", "utf-8");

    const start = source.indexOf("function Principles(");
    const nextFunc = source.indexOf("\nfunction ", start + 1);
    const body = source.slice(start, nextFunc);

    expect(body).toContain("EditableText");
    expect(body).not.toContain("editingIndex");
  });

  test("TaskCard does NOT use EditableText — task cards are read-only", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/server.ts", "utf-8");

    const start = source.indexOf("function TaskCard(");
    const nextFunc = source.indexOf("\nfunction ", start + 1);
    const body = source.slice(start, nextFunc);

    expect(body).not.toContain("EditableText");
    expect(body).not.toContain("saveTitle");
    expect(body).not.toContain("priority-edit");
    expect(body).not.toContain("setPriority");
  });

  test("EditableFeedbackMessage uses EditableText", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/server.ts", "utf-8");

    const start = source.indexOf("function EditableFeedbackMessage(");
    const nextFunc = source.indexOf("\nfunction ", start + 1);
    const body = source.slice(start, nextFunc);

    expect(body).toContain("EditableText");
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

  test("MissionCard auto-expands when mission has active tasks", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/server.ts", "utf-8");

    const start = source.indexOf("function MissionCard(");
    expect(start).toBeGreaterThan(-1);
    const nextFunc = source.indexOf("\nfunction ", start + 1);
    const body = source.slice(start, nextFunc > -1 ? nextFunc : undefined);

    expect(body).toContain("done");
    expect(body).toContain("failed");
    expect(body).toContain("useState(");
    expect(body).not.toContain("useState(false)");
  });

  test("MissionCard syncs expansion state via useEffect when hasActiveTasks changes", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/server.ts", "utf-8");

    const start = source.indexOf("function MissionCard(");
    expect(start).toBeGreaterThan(-1);
    const nextFunc = source.indexOf("\nfunction ", start + 1);
    const body = source.slice(start, nextFunc > -1 ? nextFunc : undefined);

    expect(body).toContain("useEffect");
    expect(body).toContain("hasActiveTasks");
    expect(body).toMatch(/useEffect\s*\(\s*\(\)\s*=>\s*\{[^}]*setExpanded\(true\)/);
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

  test("dashboard layout: Principles → Feedback → Missions/Tasks → Activity", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/server.ts", "utf-8");

    // Extract the App() function body to verify rendering order
    const appStart = source.indexOf("function App()");
    expect(appStart).toBeGreaterThan(-1);
    const appBody = source.slice(appStart);

    // Find first occurrence of each component after "return html"
    const returnPos = appBody.indexOf("return html");
    const layout = appBody.slice(returnPos);

    const principlesPos = layout.indexOf("Principles");
    const feedbackSectionPos = layout.indexOf("FeedbackSection");
    const feedbackFormPos = layout.indexOf("FeedbackForm");
    const reportsPos = layout.indexOf("ReportsSection");
    const missionPos = layout.indexOf("MissionSection");
    const boardPos = layout.indexOf("Board");
    const activityPos = layout.indexOf("ActivityDashboard");

    // All components must exist
    for (const [name, pos] of Object.entries({ principlesPos, feedbackSectionPos, feedbackFormPos, reportsPos, missionPos, boardPos, activityPos })) {
      expect(pos).toBeGreaterThan(-1);
    }

    // Principles first
    expect(principlesPos).toBeLessThan(feedbackSectionPos);
    expect(principlesPos).toBeLessThan(reportsPos);

    // Feedback/Reports before Missions/Tasks
    expect(feedbackSectionPos).toBeLessThan(missionPos);
    expect(reportsPos).toBeLessThan(missionPos);
    expect(feedbackFormPos).toBeLessThan(missionPos);

    // Missions/Tasks before Activity
    expect(missionPos).toBeLessThan(activityPos);
    expect(boardPos).toBeLessThan(activityPos);
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

describe("buildProjectsSummary: /api/projects returns counts instead of raw data", () => {
  function setupProjectDir(prefix: string): { projectPath: string; tasksPath: string; feedbackPath: string } {
    const projectPath = join(tmpdir(), `worqload-proj-test-${prefix}-${crypto.randomUUID()}`);
    const worqloadDir = join(projectPath, ".worqload");
    mkdirSync(worqloadDir, { recursive: true });
    return {
      projectPath,
      tasksPath: join(worqloadDir, "tasks.json"),
      feedbackPath: join(worqloadDir, "feedback.json"),
    };
  }

  test("returns taskCount and feedbackCount instead of tasks and feedback arrays", async () => {
    const { projectPath, tasksPath, feedbackPath } = setupProjectDir("counts");
    writeFileSync(tasksPath, JSON.stringify([
      { id: "t1", title: "task1", status: "observing" },
      { id: "t2", title: "task2", status: "acting" },
    ]));
    writeFileSync(feedbackPath, JSON.stringify([
      { id: "f1", message: "fix this", status: "new", from: "user", createdAt: new Date().toISOString() },
    ]));

    const projects: Project[] = [{ name: "test-proj", path: projectPath, registeredAt: new Date().toISOString() }];
    const result = await buildProjectsSummary(projects);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("test-proj");
    expect(result[0].taskCount).toBe(2);
    expect(result[0].feedbackCount).toBe(1);
    expect(result[0]).not.toHaveProperty("tasks");
    expect(result[0]).not.toHaveProperty("feedback");
  });

  test("returns zero counts when files do not exist", async () => {
    const projectPath = join(tmpdir(), `worqload-proj-test-empty-${crypto.randomUUID()}`);
    mkdirSync(projectPath, { recursive: true });

    const projects: Project[] = [{ name: "empty-proj", path: projectPath, registeredAt: new Date().toISOString() }];
    const result = await buildProjectsSummary(projects);

    expect(result).toHaveLength(1);
    expect(result[0].taskCount).toBe(0);
    expect(result[0].feedbackCount).toBe(0);
  });

  test("handles multiple projects independently", async () => {
    const p1 = setupProjectDir("multi1");
    const p2 = setupProjectDir("multi2");
    writeFileSync(p1.tasksPath, JSON.stringify([{ id: "t1" }]));
    writeFileSync(p1.feedbackPath, JSON.stringify([{ id: "f1" }, { id: "f2" }]));
    writeFileSync(p2.tasksPath, JSON.stringify([{ id: "t2" }, { id: "t3" }, { id: "t4" }]));
    writeFileSync(p2.feedbackPath, JSON.stringify([]));

    const projects: Project[] = [
      { name: "proj-a", path: p1.projectPath, registeredAt: new Date().toISOString() },
      { name: "proj-b", path: p2.projectPath, registeredAt: new Date().toISOString() },
    ];
    const result = await buildProjectsSummary(projects);

    expect(result).toHaveLength(2);
    expect(result[0].taskCount).toBe(1);
    expect(result[0].feedbackCount).toBe(2);
    expect(result[1].taskCount).toBe(3);
    expect(result[1].feedbackCount).toBe(0);
  });
});

describe("matchRoute: table-driven routing", () => {
  const routes: Route[] = [
    { method: "GET", pattern: "/api/tasks", handler: async () => new Response("tasks list") },
    { method: "POST", pattern: "/api/tasks", handler: async () => new Response("task created", { status: 201 }) },
    { method: "GET", pattern: /^\/api\/tasks\/([^/]+)$/, handler: async (_req, _queue, _port, params) => new Response(`task ${params[0]}`) },
    { method: "PATCH", pattern: /^\/api\/tasks\/([^/]+)$/, handler: async (_req, _queue, _port, params) => new Response(`updated ${params[0]}`) },
    { method: "DELETE", pattern: /^\/api\/tasks\/([^/]+)$/, handler: async (_req, _queue, _port, params) => new Response(`deleted ${params[0]}`) },
  ];

  test("matches exact string path with correct method", () => {
    const result = matchRoute("GET", "/api/tasks", routes);
    expect(result).not.toBeNull();
    expect(result!.route.method).toBe("GET");
    expect(result!.params).toEqual([]);
  });

  test("matches POST on same path separately from GET", () => {
    const result = matchRoute("POST", "/api/tasks", routes);
    expect(result).not.toBeNull();
    expect(result!.route.method).toBe("POST");
  });

  test("matches regex pattern and extracts params", () => {
    const result = matchRoute("GET", "/api/tasks/abc123", routes);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual(["abc123"]);
  });

  test("matches correct method for regex patterns", () => {
    const get = matchRoute("GET", "/api/tasks/abc123", routes);
    const patch = matchRoute("PATCH", "/api/tasks/abc123", routes);
    const del = matchRoute("DELETE", "/api/tasks/abc123", routes);
    expect(get).not.toBeNull();
    expect(patch).not.toBeNull();
    expect(del).not.toBeNull();
    expect(get!.route.method).toBe("GET");
    expect(patch!.route.method).toBe("PATCH");
    expect(del!.route.method).toBe("DELETE");
  });

  test("returns null when no route matches", () => {
    const result = matchRoute("GET", "/api/nonexistent", routes);
    expect(result).toBeNull();
  });

  test("returns null when method does not match", () => {
    const result = matchRoute("PUT", "/api/tasks", routes);
    expect(result).toBeNull();
  });

  test("does not match partial string paths", () => {
    const result = matchRoute("GET", "/api/tasks/extra", routes);
    // Should match the regex pattern, not the exact string
    expect(result).not.toBeNull();
    expect(result!.params).toEqual(["extra"]);
  });

  test("exact string match takes priority over regex when both match", () => {
    const result = matchRoute("GET", "/api/tasks", routes);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual([]);
  });

  test("handler receives extracted params", async () => {
    const result = matchRoute("GET", "/api/tasks/my-task-id", routes);
    expect(result).not.toBeNull();
    const response = await result!.route.handler(new Request("http://localhost/api/tasks/my-task-id"), null as any, 3456, result!.params);
    expect(await response.text()).toBe("task my-task-id");
  });
});

describe("loadAllProjectFeedback: aggregates feedback across projects with project name", () => {
  function setupProjectDir(prefix: string): { projectPath: string; feedbackPath: string } {
    const projectPath = join(tmpdir(), `worqload-allfb-test-${prefix}-${crypto.randomUUID()}`);
    const worqloadDir = join(projectPath, ".worqload");
    mkdirSync(worqloadDir, { recursive: true });
    return {
      projectPath,
      feedbackPath: join(worqloadDir, "feedback.json"),
    };
  }

  test("returns feedback from all projects with projectName attached", async () => {
    const p1 = setupProjectDir("fb1");
    const p2 = setupProjectDir("fb2");
    writeFileSync(p1.feedbackPath, JSON.stringify([
      { id: "f1", message: "issue A", status: "new", from: "user", createdAt: "2026-01-01T00:00:00Z" },
    ]));
    writeFileSync(p2.feedbackPath, JSON.stringify([
      { id: "f2", message: "issue B", status: "new", from: "admin", createdAt: "2026-01-02T00:00:00Z" },
    ]));

    const projects: Project[] = [
      { name: "alpha", path: p1.projectPath, registeredAt: new Date().toISOString() },
      { name: "beta", path: p2.projectPath, registeredAt: new Date().toISOString() },
    ];
    const result = await loadAllProjectFeedback(projects);

    expect(result).toHaveLength(2);
    const alpha = result.find((f: any) => f.id === "f1");
    const beta = result.find((f: any) => f.id === "f2");
    expect(alpha.projectName).toBe("alpha");
    expect(beta.projectName).toBe("beta");
  });

  test("returns empty array when no projects have feedback", async () => {
    const p1 = setupProjectDir("nofb");
    const projects: Project[] = [
      { name: "empty", path: p1.projectPath, registeredAt: new Date().toISOString() },
    ];
    writeFileSync(p1.feedbackPath, JSON.stringify([]));
    const result = await loadAllProjectFeedback(projects);
    expect(result).toEqual([]);
  });

  test("handles missing feedback files gracefully", async () => {
    const projectPath = join(tmpdir(), `worqload-allfb-test-missing-${crypto.randomUUID()}`);
    mkdirSync(projectPath, { recursive: true });

    const projects: Project[] = [
      { name: "no-file", path: projectPath, registeredAt: new Date().toISOString() },
    ];
    const result = await loadAllProjectFeedback(projects);
    expect(result).toEqual([]);
  });
});

describe("POST /api/missions/:id/archive", () => {
  test("archives a completed mission", async () => {
    const missionsPath = tmpPath("missions");
    const archivePath = tmpPath("mission-archive");
    const m = await createMission("To archive", {}, missionsPath);
    await completeMission(m.id, missionsPath);
    const archived = await archiveMissions([m.id], missionsPath, archivePath);
    expect(archived).toHaveLength(1);
    expect(archived[0].name).toBe("To archive");
    const remaining = await loadMissions(missionsPath);
    expect(remaining).toHaveLength(0);
    const archivedList = await loadMissionArchive(archivePath);
    expect(archivedList).toHaveLength(1);
  });

  test("rejects archiving an active mission", async () => {
    const missionsPath = tmpPath("missions");
    const archivePath = tmpPath("mission-archive");
    const m = await createMission("Still active", {}, missionsPath);
    expect(archiveMissions([m.id], missionsPath, archivePath)).rejects.toThrow("Cannot archive active mission");
  });
});
