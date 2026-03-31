import { EntityStore } from "./utils/entity-store";

const DEFAULT_PATH = ".worqload/mission-runners.json";

export interface RunnerState {
  id: string;
  missionId: string;
  missionName: string;
  pid: number;
  status: "running" | "idle" | "stopped";
  startedAt: string;
  lastHeartbeat: string;
  currentTaskId?: string;
  currentTaskTitle?: string;
  tasksProcessed: number;
  consecutiveIdles: number;
}

const store = new EntityStore<RunnerState>(DEFAULT_PATH, "RunnerState");

export async function loadRunnerStates(path: string = DEFAULT_PATH): Promise<RunnerState[]> {
  return store.load(path);
}

export async function loadRunnerStatesUnlocked(path: string = DEFAULT_PATH): Promise<RunnerState[]> {
  return store.loadUnlocked(path);
}

export async function registerRunner(
  missionId: string,
  missionName: string,
  pid: number,
  path: string = DEFAULT_PATH,
): Promise<RunnerState> {
  const state: RunnerState = {
    id: crypto.randomUUID(),
    missionId,
    missionName,
    pid,
    status: "running",
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    tasksProcessed: 0,
    consecutiveIdles: 0,
  };
  return store.add(state, path);
}

export async function heartbeatRunner(
  id: string,
  update: Partial<Pick<RunnerState, "status" | "currentTaskId" | "currentTaskTitle" | "tasksProcessed" | "consecutiveIdles">>,
  path: string = DEFAULT_PATH,
): Promise<void> {
  await store.update(id, { ...update, lastHeartbeat: new Date().toISOString() }, path);
}

export async function deregisterRunner(id: string, path: string = DEFAULT_PATH): Promise<void> {
  await store.update(id, { status: "stopped" as const, lastHeartbeat: new Date().toISOString() }, path);
}
