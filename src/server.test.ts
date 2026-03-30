import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { createTask } from "./task";
import { TaskQueue } from "./queue";
import { createMission, loadMissions, saveMissions } from "./mission";
import type { Mission } from "./mission";

const REAL_STORE = ".worqload/tasks.json";
const REAL_MISSIONS = ".worqload/missions.json";
let taskSnapshot: string | null = null;
let missionSnapshot: string | null = null;

beforeAll(() => {
  try { taskSnapshot = readFileSync(REAL_STORE, "utf-8"); } catch { taskSnapshot = null; }
  try { missionSnapshot = readFileSync(REAL_MISSIONS, "utf-8"); } catch { missionSnapshot = null; }
});

afterAll(() => {
  let taskAfter: string | null = null;
  let missionAfter: string | null = null;
  try { taskAfter = readFileSync(REAL_STORE, "utf-8"); } catch { taskAfter = null; }
  try { missionAfter = readFileSync(REAL_MISSIONS, "utf-8"); } catch { missionAfter = null; }
  if (taskSnapshot !== taskAfter) throw new Error("Tests modified the real tasks.json!");
  if (missionSnapshot !== missionAfter) throw new Error("Tests modified the real missions.json!");
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
});
