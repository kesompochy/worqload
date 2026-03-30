import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadMissions,
  saveMissions,
  createMission,
  completeMission,
} from "./mission";
import type { Mission } from "./mission";

function tmpPath(): string {
  return join(tmpdir(), `worqload-mission-test-${crypto.randomUUID()}.json`);
}

test("loadMissions returns empty array when file does not exist", async () => {
  expect(await loadMissions(tmpPath())).toEqual([]);
});

test("createMission creates a mission with name and default filter", async () => {
  const path = tmpPath();
  const mission = await createMission("refactor-auth", {}, path);

  expect(mission.name).toBe("refactor-auth");
  expect(mission.status).toBe("active");
  expect(mission.filter).toEqual({});
  expect(mission.id).toBeDefined();
  expect(mission.createdAt).toBeDefined();

  const loaded = await loadMissions(path);
  expect(loaded).toHaveLength(1);
  expect(loaded[0].id).toBe(mission.id);
});

test("createMission creates a mission with tag filter", async () => {
  const path = tmpPath();
  const mission = await createMission(
    "test-coverage",
    { tags: ["test", "coverage"] },
    path,
  );

  expect(mission.filter.tags).toEqual(["test", "coverage"]);
});

test("createMission throws on empty name", async () => {
  const path = tmpPath();
  expect(createMission("  ", {}, path)).rejects.toThrow(
    "Mission name must not be empty",
  );
});

test("completeMission changes status to completed", async () => {
  const path = tmpPath();
  const mission = await createMission("my-mission", {}, path);

  await completeMission(mission.id, path);
  const loaded = await loadMissions(path);
  expect(loaded[0].status).toBe("completed");
});

test("completeMission matches by id prefix", async () => {
  const path = tmpPath();
  const mission = await createMission("my-mission", {}, path);

  await completeMission(mission.id.slice(0, 8), path);
  const loaded = await loadMissions(path);
  expect(loaded[0].status).toBe("completed");
});

test("completeMission throws for unknown id", async () => {
  const path = tmpPath();
  expect(completeMission("nonexistent", path)).rejects.toThrow(
    "Mission not found",
  );
});

test("completeMission throws if already completed", async () => {
  const path = tmpPath();
  const mission = await createMission("done-mission", {}, path);
  await completeMission(mission.id, path);

  expect(completeMission(mission.id, path)).rejects.toThrow(
    "already completed",
  );
});

test("multiple missions can be created and loaded", async () => {
  const path = tmpPath();
  await createMission("mission-a", {}, path);
  await createMission("mission-b", { tags: ["infra"] }, path);

  const loaded = await loadMissions(path);
  expect(loaded).toHaveLength(2);
  expect(loaded.map((m) => m.name)).toEqual(["mission-a", "mission-b"]);
});
