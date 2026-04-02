import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "./queue";
import { createTask } from "./task";
import { saveSpawns, loadSpawns } from "./spawns";
import type { SpawnRecord } from "./spawns";
import { spawnCleanup } from "./commands/spawn";

function tmpPath(prefix: string): string {
  return join(tmpdir(), `worqload-${prefix}-${crypto.randomUUID()}.json`);
}

function makeSpawnRecord(
  taskId: string,
  taskTitle: string,
  pid: number,
): SpawnRecord {
  return {
    id: crypto.randomUUID(),
    taskId,
    taskTitle,
    owner: "test-agent",
    pid,
    status: "running",
    startedAt: new Date().toISOString(),
  };
}

test("spawnCleanup fails observing task with dead spawn process", async () => {
  const storePath = tmpPath("tasks");
  const spawnsPath = tmpPath("spawns");
  const queue = new TaskQueue(storePath);

  const task = createTask("stuck observing");
  queue.enqueue(task);
  queue.update(task.id, { owner: "test-agent" });
  await queue.save();

  await saveSpawns([makeSpawnRecord(task.id, task.title, 999999999)], spawnsPath);

  await spawnCleanup(queue, [], spawnsPath);

  const updated = queue.get(task.id);
  expect(updated?.status).toBe("failed");
  expect(updated?.owner).toBeUndefined();
  expect(updated?.logs.some((l) => l.content.includes("timeout"))).toBe(true);
});

test("spawnCleanup fails acting task with dead spawn process", async () => {
  const storePath = tmpPath("tasks");
  const spawnsPath = tmpPath("spawns");
  const queue = new TaskQueue(storePath);

  const task = createTask("stuck acting");
  queue.enqueue(task);
  queue.update(task.id, { status: "acting", owner: "test-agent" });
  await queue.save();

  await saveSpawns([makeSpawnRecord(task.id, task.title, 999999999)], spawnsPath);

  await spawnCleanup(queue, [], spawnsPath);

  const updated = queue.get(task.id);
  expect(updated?.status).toBe("failed");
  expect(updated?.owner).toBeUndefined();
});

test("spawnCleanup skips task with live process", async () => {
  const storePath = tmpPath("tasks");
  const spawnsPath = tmpPath("spawns");
  const queue = new TaskQueue(storePath);

  const task = createTask("active task");
  queue.enqueue(task);
  queue.update(task.id, { owner: "test-agent" });
  await queue.save();

  await saveSpawns(
    [makeSpawnRecord(task.id, task.title, process.pid)],
    spawnsPath,
  );

  await spawnCleanup(queue, [], spawnsPath);

  const updated = queue.get(task.id);
  expect(updated?.status).toBe("observing");
  expect(updated?.owner).toBe("test-agent");
});

test("spawnCleanup fails task with no spawn record", async () => {
  const storePath = tmpPath("tasks");
  const spawnsPath = tmpPath("spawns");
  const queue = new TaskQueue(storePath);

  const task = createTask("orphaned task");
  queue.enqueue(task);
  queue.update(task.id, { owner: "test-agent" });
  await queue.save();

  await saveSpawns([], spawnsPath);

  await spawnCleanup(queue, [], spawnsPath);

  const updated = queue.get(task.id);
  expect(updated?.status).toBe("failed");
  expect(updated?.owner).toBeUndefined();
});

test("spawnCleanup marks spawn record as failed", async () => {
  const storePath = tmpPath("tasks");
  const spawnsPath = tmpPath("spawns");
  const queue = new TaskQueue(storePath);

  const task = createTask("stuck task");
  queue.enqueue(task);
  queue.update(task.id, { owner: "test-agent" });
  await queue.save();

  const record = makeSpawnRecord(task.id, task.title, 999999999);
  await saveSpawns([record], spawnsPath);

  await spawnCleanup(queue, [], spawnsPath);

  const spawns = await loadSpawns(spawnsPath);
  const updatedRecord = spawns.find((s) => s.id === record.id);
  expect(updatedRecord?.status).toBe("failed");
  expect(updatedRecord?.finishedAt).toBeTruthy();
});

test("spawnCleanup skips mission-owned task when runner daemon is alive", async () => {
  const storePath = tmpPath("tasks");
  const spawnsPath = tmpPath("spawns");
  const runnerStatePath = tmpPath("runners");
  const queue = new TaskQueue(storePath);

  const task = createTask("mission task");
  queue.enqueue(task);
  queue.update(task.id, { status: "acting", owner: "mission:TestMission" });
  await queue.save();

  await saveSpawns([], spawnsPath);

  // Register a runner with the current PID (alive)
  const { registerRunner } = await import("./mission-runner-state");
  await registerRunner("mission-1", "TestMission", process.pid, runnerStatePath);

  await spawnCleanup(queue, [], spawnsPath, undefined, runnerStatePath);

  const updated = queue.get(task.id);
  expect(updated?.status).toBe("acting");
  expect(updated?.owner).toBe("mission:TestMission");
});

test("spawnCleanup fails mission-owned task when runner daemon is dead", async () => {
  const storePath = tmpPath("tasks");
  const spawnsPath = tmpPath("spawns");
  const runnerStatePath = tmpPath("runners");
  const queue = new TaskQueue(storePath);

  const task = createTask("dead mission task");
  queue.enqueue(task);
  queue.update(task.id, { status: "acting", owner: "mission:DeadMission" });
  await queue.save();

  await saveSpawns([], spawnsPath);

  // Register a runner with a dead PID
  const { registerRunner } = await import("./mission-runner-state");
  await registerRunner("mission-2", "DeadMission", 999999, runnerStatePath);

  await spawnCleanup(queue, [], spawnsPath, undefined, runnerStatePath);

  const updated = queue.get(task.id);
  expect(updated?.status).toBe("failed");
  expect(updated?.owner).toBeUndefined();
});

test("spawnCleanup handles no stuck tasks", async () => {
  const storePath = tmpPath("tasks");
  const spawnsPath = tmpPath("spawns");
  const queue = new TaskQueue(storePath);

  const task = createTask("normal observing");
  queue.enqueue(task);
  await queue.save();

  await saveSpawns([], spawnsPath);

  await spawnCleanup(queue, [], spawnsPath);

  const updated = queue.get(task.id);
  expect(updated?.status).toBe("observing");
});
