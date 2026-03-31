import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadRunnerStates,
  registerRunner,
  heartbeatRunner,
  deregisterRunner,
} from "./mission-runner-state";

function tmpPath(): string {
  return join(tmpdir(), `worqload-runners-test-${crypto.randomUUID()}.json`);
}

test("loadRunnerStates returns empty array when file does not exist", async () => {
  const path = tmpPath();
  expect(await loadRunnerStates(path)).toEqual([]);
});

test("registerRunner creates a running record", async () => {
  const path = tmpPath();
  const state = await registerRunner("mission-1", "Test Mission", 1234, path);

  expect(state.missionId).toBe("mission-1");
  expect(state.missionName).toBe("Test Mission");
  expect(state.pid).toBe(1234);
  expect(state.status).toBe("running");
  expect(state.tasksProcessed).toBe(0);
  expect(state.consecutiveIdles).toBe(0);
  expect(state.id).toBeTruthy();
  expect(state.startedAt).toBeTruthy();
  expect(state.lastHeartbeat).toBeTruthy();

  const states = await loadRunnerStates(path);
  expect(states).toHaveLength(1);
  expect(states[0].id).toBe(state.id);
});

test("heartbeatRunner updates status and timestamp", async () => {
  const path = tmpPath();
  const state = await registerRunner("mission-1", "Test", 1000, path);
  const originalHeartbeat = state.lastHeartbeat;

  await Bun.sleep(10);
  await heartbeatRunner(state.id, {
    status: "idle",
    tasksProcessed: 3,
    consecutiveIdles: 1,
  }, path);

  const states = await loadRunnerStates(path);
  const updated = states[0];
  expect(updated.status).toBe("idle");
  expect(updated.tasksProcessed).toBe(3);
  expect(updated.consecutiveIdles).toBe(1);
  expect(updated.lastHeartbeat).not.toBe(originalHeartbeat);
});

test("heartbeatRunner updates current task info", async () => {
  const path = tmpPath();
  const state = await registerRunner("mission-1", "Test", 1000, path);

  await heartbeatRunner(state.id, {
    status: "running",
    currentTaskId: "task-42",
    currentTaskTitle: "Do something",
    tasksProcessed: 1,
  }, path);

  const states = await loadRunnerStates(path);
  expect(states[0].currentTaskId).toBe("task-42");
  expect(states[0].currentTaskTitle).toBe("Do something");
});

test("deregisterRunner marks runner as stopped", async () => {
  const path = tmpPath();
  const state = await registerRunner("mission-1", "Test", 1000, path);

  await deregisterRunner(state.id, path);

  const states = await loadRunnerStates(path);
  expect(states[0].status).toBe("stopped");
});

test("multiple runners tracked independently", async () => {
  const path = tmpPath();
  const r1 = await registerRunner("mission-1", "Alpha", 100, path);
  const r2 = await registerRunner("mission-2", "Beta", 200, path);

  await heartbeatRunner(r1.id, { status: "idle", consecutiveIdles: 2 }, path);
  await deregisterRunner(r2.id, path);

  const states = await loadRunnerStates(path);
  expect(states).toHaveLength(2);
  expect(states.find(s => s.id === r1.id)!.status).toBe("idle");
  expect(states.find(s => s.id === r2.id)!.status).toBe("stopped");
});
