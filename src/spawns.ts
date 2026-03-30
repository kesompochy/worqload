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
}

const store = new EntityStore<SpawnRecord>(DEFAULT_SPAWNS_PATH, "Spawn");

export async function loadSpawns(path: string = DEFAULT_SPAWNS_PATH): Promise<SpawnRecord[]> {
  return store.load(path);
}

export async function saveSpawns(spawns: SpawnRecord[], path: string = DEFAULT_SPAWNS_PATH): Promise<void> {
  await store.save(spawns, path);
}

export async function recordSpawnStart(taskId: string, taskTitle: string, owner: string, pid: number, path: string = DEFAULT_SPAWNS_PATH): Promise<SpawnRecord> {
  const record: SpawnRecord = {
    id: crypto.randomUUID(),
    taskId,
    taskTitle,
    owner,
    pid,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  return store.add(record, path);
}

export async function recordSpawnFinish(id: string, exitCode: number, path: string = DEFAULT_SPAWNS_PATH): Promise<void> {
  const spawns = await store.load(path);
  const record = spawns.find(s => s.id === id);
  if (!record) return;
  record.status = exitCode === 0 ? "done" : "failed";
  record.finishedAt = new Date().toISOString();
  record.exitCode = exitCode;
  await store.save(spawns, path);
}
