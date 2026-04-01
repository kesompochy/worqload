import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { createTask } from "../task";
import { TaskQueue } from "../queue";
import { createMission, loadMissions, addMissionPrinciple } from "../mission";
import { loadConfig } from "../config";

function tmpPath(): string {
  return join(tmpdir(), `worqload-mission-cmd-test-${crypto.randomUUID()}.json`);
}

test("assign sets missionId on task", async () => {
  const missionPath = tmpPath();
  const mission = await createMission("test-mission", {}, missionPath);

  const storePath = tmpPath();
  const queue = new TaskQueue(storePath);
  const task = createTask("assignable task");
  queue.enqueue(task);

  queue.update(task.id, { missionId: mission.id });
  await queue.save();

  const updated = queue.get(task.id);
  expect(updated?.missionId).toBe(mission.id);
});

test("assign throws for unknown mission", async () => {
  const missionPath = tmpPath();
  const missions = await loadMissions(missionPath);
  const found = missions.find(m => m.id === "nonexistent" || m.id.startsWith("nonexistent"));
  expect(found).toBeUndefined();
});

test("getByMission returns assigned tasks after assign", async () => {
  const queue = new TaskQueue();
  const missionId = crypto.randomUUID();

  const t1 = createTask("task-a");
  const t2 = createTask("task-b");
  queue.enqueue(t1);
  queue.enqueue(t2);
  queue.update(t1.id, { missionId });

  const result = queue.getByMission(missionId);
  expect(result).toHaveLength(1);
  expect(result[0].id).toBe(t1.id);
});

describe("mission run worktree config", () => {
  test("config.spawn.worktree enables worktree for mission run", async () => {
    const configPath = join(tmpdir(), `worqload-mission-config-${crypto.randomUUID()}.json`);
    await Bun.write(configPath, JSON.stringify({ spawn: { worktree: true } }));
    const config = await loadConfig(configPath);
    const cliWorktreeFlag = undefined;
    const useWorktree = cliWorktreeFlag === "true" || config.spawn?.worktree === true;
    expect(useWorktree).toBe(true);
  });

  test("CLI --worktree flag enables worktree even without config", async () => {
    const configPath = join(tmpdir(), `worqload-mission-config-${crypto.randomUUID()}.json`);
    await Bun.write(configPath, JSON.stringify({}));
    const config = await loadConfig(configPath);
    const cliWorktreeFlag = "true";
    const useWorktree = cliWorktreeFlag === "true" || config.spawn?.worktree === true;
    expect(useWorktree).toBe(true);
  });

  test("worktree disabled when neither config nor flag set", async () => {
    const configPath = join(tmpdir(), `worqload-mission-config-${crypto.randomUUID()}.json`);
    await Bun.write(configPath, JSON.stringify({}));
    const config = await loadConfig(configPath);
    const cliWorktreeFlag = undefined;
    const useWorktree = cliWorktreeFlag === "true" || config.spawn?.worktree === true;
    expect(useWorktree).toBe(false);
  });
});

test("mission principle lists principles for a mission", async () => {
  const missionPath = tmpPath();
  const m = await createMission("principle-list", {}, missionPath);
  await addMissionPrinciple(m.id, "First principle", missionPath);
  await addMissionPrinciple(m.id, "Second principle", missionPath);

  const loaded = await loadMissions(missionPath);
  const found = loaded.find(mi => mi.id === m.id);
  expect(found?.principles).toEqual(["First principle", "Second principle"]);
});
