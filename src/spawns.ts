import { EntityStore } from "./utils/entity-store";

const DEFAULT_SPAWNS_PATH = ".worqload/spawns.json";

export interface SpawnRecord {
  id: string;
  taskId: string;
  taskTitle: string;
  owner: string;
  pid: number;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  worktreePath?: string;
  branchName?: string;
}

const store = new EntityStore<SpawnRecord>(DEFAULT_SPAWNS_PATH, "Spawn");

export async function loadSpawns(path: string = DEFAULT_SPAWNS_PATH): Promise<SpawnRecord[]> {
  return store.load(path);
}

export async function saveSpawns(spawns: SpawnRecord[], path: string = DEFAULT_SPAWNS_PATH): Promise<void> {
  await store.save(spawns, path);
}

export async function recordSpawnStart(taskId: string, taskTitle: string, owner: string, pid: number, path: string = DEFAULT_SPAWNS_PATH, worktreeInfo?: { worktreePath: string; branchName: string }): Promise<SpawnRecord> {
  return store.create({
    taskId,
    taskTitle,
    owner,
    pid,
    status: "running" as const,
    startedAt: new Date().toISOString(),
    ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName } : {}),
  }, path);
}

export async function recordSpawnFinish(id: string, exitCode: number, path: string = DEFAULT_SPAWNS_PATH): Promise<void> {
  try {
    await store.update(id, {
      status: exitCode === 0 ? "done" : "failed",
      finishedAt: new Date().toISOString(),
      exitCode,
    }, path);
  } catch {
    // Silent no-op when spawn record not found
  }
}
