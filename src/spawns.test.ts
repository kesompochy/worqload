import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadSpawns,
  saveSpawns,
  recordSpawnStart,
  recordSpawnFinish,
} from "./spawns";
import type { SpawnRecord } from "./spawns";

function tmpSpawnsPath(): string {
  return join(tmpdir(), `worqload-spawns-test-${crypto.randomUUID()}.json`);
}

test("loadSpawns returns empty array when file does not exist", async () => {
  const path = tmpSpawnsPath();
  expect(await loadSpawns(path)).toEqual([]);
});

test("saveSpawns then loadSpawns round-trips", async () => {
  const path = tmpSpawnsPath();
  const record: SpawnRecord = {
    id: "test-id",
    taskId: "task-1",
    taskTitle: "Test task",
    owner: "spawn-123",
    pid: 12345,
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
  };

  await saveSpawns([record], path);
  const loaded = await loadSpawns(path);
  expect(loaded).toEqual([record]);
});

test("recordSpawnStart creates a running record", async () => {
  const path = tmpSpawnsPath();
  const record = await recordSpawnStart("task-1", "My task", "spawn-42", 9999, path);

  expect(record.taskId).toBe("task-1");
  expect(record.taskTitle).toBe("My task");
  expect(record.owner).toBe("spawn-42");
  expect(record.pid).toBe(9999);
  expect(record.status).toBe("running");
  expect(record.id).toBeTruthy();
  expect(record.startedAt).toBeTruthy();
  expect(record.finishedAt).toBeUndefined();

  const spawns = await loadSpawns(path);
  expect(spawns).toHaveLength(1);
  expect(spawns[0].id).toBe(record.id);
});

test("recordSpawnFinish marks record as done on exit code 0", async () => {
  const path = tmpSpawnsPath();
  const record = await recordSpawnStart("task-1", "Success task", "owner", 100, path);

  await recordSpawnFinish(record.id, 0, path);

  const spawns = await loadSpawns(path);
  expect(spawns[0].status).toBe("done");
  expect(spawns[0].exitCode).toBe(0);
  expect(spawns[0].finishedAt).toBeTruthy();
});

test("recordSpawnFinish marks record as failed on non-zero exit code", async () => {
  const path = tmpSpawnsPath();
  const record = await recordSpawnStart("task-1", "Fail task", "owner", 200, path);

  await recordSpawnFinish(record.id, 1, path);

  const spawns = await loadSpawns(path);
  expect(spawns[0].status).toBe("failed");
  expect(spawns[0].exitCode).toBe(1);
});

test("recordSpawnFinish with unknown id is a no-op", async () => {
  const path = tmpSpawnsPath();
  await recordSpawnStart("task-1", "Task", "owner", 300, path);

  await recordSpawnFinish("nonexistent-id", 0, path);

  const spawns = await loadSpawns(path);
  expect(spawns[0].status).toBe("running");
});

test("multiple spawns are tracked independently", async () => {
  const path = tmpSpawnsPath();
  const r1 = await recordSpawnStart("task-1", "Task A", "agent-1", 100, path);
  const r2 = await recordSpawnStart("task-2", "Task B", "agent-2", 200, path);

  await recordSpawnFinish(r1.id, 0, path);

  const spawns = await loadSpawns(path);
  expect(spawns).toHaveLength(2);
  expect(spawns.find(s => s.id === r1.id)!.status).toBe("done");
  expect(spawns.find(s => s.id === r2.id)!.status).toBe("running");
});
