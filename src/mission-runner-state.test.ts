import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadRunnerStates,
  loadRunnerStatesUnlocked,
  registerRunner,
  heartbeatRunner,
  deregisterRunner,
  isProcessAlive,
  detectDeadRunners,
  type RunnerState,
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

test("loadRunnerStatesUnlocked reads without lock", async () => {
  const path = tmpPath();
  await registerRunner("mission-1", "Test", 1234, path);

  const states = await loadRunnerStatesUnlocked(path);
  expect(states).toHaveLength(1);
  expect(states[0].missionName).toBe("Test");
});

test("loadRunnerStatesUnlocked returns empty when no file", async () => {
  const path = tmpPath();
  expect(await loadRunnerStatesUnlocked(path)).toEqual([]);
});

test("isProcessAlive returns true for current process", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
});

test("isProcessAlive returns false for non-existent process", () => {
  expect(isProcessAlive(999999)).toBe(false);
});

test("detectDeadRunners finds runners with dead PIDs", () => {
  const runners: RunnerState[] = [
    {
      id: "r-1",
      missionId: "m-1",
      missionName: "Alpha",
      pid: 999999,
      status: "running",
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      tasksProcessed: 0,
      consecutiveIdles: 0,
    },
  ];
  const dead = detectDeadRunners(runners);
  expect(dead).toHaveLength(1);
  expect(dead[0].missionId).toBe("m-1");
  expect(dead[0].pid).toBe(999999);
});

test("detectDeadRunners skips stopped runners", () => {
  const runners: RunnerState[] = [
    {
      id: "r-1",
      missionId: "m-1",
      missionName: "Alpha",
      pid: 999999,
      status: "stopped",
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      tasksProcessed: 0,
      consecutiveIdles: 0,
    },
  ];
  const dead = detectDeadRunners(runners);
  expect(dead).toHaveLength(0);
});

test("detectDeadRunners skips alive runners", () => {
  const runners: RunnerState[] = [
    {
      id: "r-1",
      missionId: "m-1",
      missionName: "Alpha",
      pid: process.pid,
      status: "running",
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      tasksProcessed: 0,
      consecutiveIdles: 0,
    },
  ];
  const dead = detectDeadRunners(runners);
  expect(dead).toHaveLength(0);
});

test("hasAliveRunnerForMission returns true when running process exists", async () => {
  const path = tmpPath();
  await registerRunner("mission-1", "Alpha", process.pid, path);
  const { hasAliveRunnerForMission } = await import("./mission-runner-state");
  expect(await hasAliveRunnerForMission("mission-1", path)).toBe(true);
});

test("hasAliveRunnerForMission returns false when process is dead", async () => {
  const path = tmpPath();
  await registerRunner("mission-1", "Alpha", 999999, path);
  const { hasAliveRunnerForMission } = await import("./mission-runner-state");
  expect(await hasAliveRunnerForMission("mission-1", path)).toBe(false);
});

test("hasAliveRunnerForMission returns false when runner is stopped", async () => {
  const path = tmpPath();
  const r = await registerRunner("mission-1", "Alpha", process.pid, path);
  await deregisterRunner(r.id, path);
  const { hasAliveRunnerForMission } = await import("./mission-runner-state");
  expect(await hasAliveRunnerForMission("mission-1", path)).toBe(false);
});

test("hasAliveRunnerForMission returns false when no runners exist", async () => {
  const path = tmpPath();
  const { hasAliveRunnerForMission } = await import("./mission-runner-state");
  expect(await hasAliveRunnerForMission("mission-1", path)).toBe(false);
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
