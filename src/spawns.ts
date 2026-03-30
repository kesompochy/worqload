import { loadJsonFile, saveJsonFile } from "./utils/json-store";

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

export async function loadSpawns(path: string = DEFAULT_SPAWNS_PATH): Promise<SpawnRecord[]> {
  return loadJsonFile<SpawnRecord[]>(path, []);
}

export async function saveSpawns(spawns: SpawnRecord[], path: string = DEFAULT_SPAWNS_PATH): Promise<void> {
  await saveJsonFile(path, spawns);
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
  const spawns = await loadSpawns(path);
  spawns.push(record);
  await saveSpawns(spawns, path);
  return record;
}

export async function recordSpawnFinish(id: string, exitCode: number, path: string = DEFAULT_SPAWNS_PATH): Promise<void> {
  const spawns = await loadSpawns(path);
  const record = spawns.find(s => s.id === id);
  if (!record) return;
  record.status = exitCode === 0 ? "done" : "failed";
  record.finishedAt = new Date().toISOString();
  record.exitCode = exitCode;
  await saveSpawns(spawns, path);
}
