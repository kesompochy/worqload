import { loadJsonFileUnlocked } from "./utils/json-store";
import { withLock } from "./lock";
import { EntityStore } from "./utils/entity-store";

const DEFAULT_MISSIONS_PATH = ".worqload/missions.json";
const DEFAULT_MISSION_ARCHIVE_PATH = ".worqload/mission-archive.json";

export type MissionStatus = "active" | "completed" | "failed";

export interface MissionFilter {
  tags?: string[];
}

export interface Mission {
  id: string;
  name: string;
  filter: MissionFilter;
  principles: string[];
  priority: number;
  status: MissionStatus;
  createdAt: string;
}

const store = new EntityStore<Mission>(DEFAULT_MISSIONS_PATH, "Mission");

export async function loadMissions(path?: string): Promise<Mission[]> {
  const missions = await store.load(path);
  return missions.map(m => ({ priority: 0, ...m }));
}

export async function saveMissions(missions: Mission[], path?: string): Promise<void> {
  await store.save(missions, path);
}

export async function findMissionById(id: string, path?: string): Promise<Mission | undefined> {
  const mission = await store.findById(id, path);
  if (!mission) return undefined;
  return { priority: 0, ...mission };
}

export async function createMission(name: string, filter: MissionFilter = {}, path?: string, priority = 0): Promise<Mission> {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("Mission name must not be empty");
  }
  const mission: Mission = {
    id: crypto.randomUUID(),
    name: trimmed,
    filter,
    principles: [],
    priority,
    status: "active",
    createdAt: new Date().toISOString(),
  };
  return store.add(mission, path);
}

export async function addMissionPrinciple(id: string, text: string, path?: string): Promise<void> {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error("Principle text must not be empty");
  }
  const mission = await findMissionById(id, path);
  if (!mission) throw new Error(`Mission not found: ${id}`);
  await store.update(id, { principles: [...(mission.principles || []), trimmed] }, path);
}

export async function removeMissionPrinciple(id: string, index: number, path?: string): Promise<void> {
  const mission = await findMissionById(id, path);
  if (!mission) throw new Error(`Mission not found: ${id}`);
  const principles = [...(mission.principles || [])];
  if (index < 0 || index >= principles.length) {
    throw new Error(`Principle index out of range: ${index}`);
  }
  principles.splice(index, 1);
  await store.update(id, { principles }, path);
}

export async function completeMission(id: string, path?: string): Promise<void> {
  const mission = await findMissionById(id, path);
  if (!mission) throw new Error(`Mission not found: ${id}`);
  if (mission.status === "completed") throw new Error(`Mission is already completed: ${id}`);
  await store.update(id, { status: "completed" }, path);
}

export async function failMission(id: string, path?: string): Promise<void> {
  const mission = await findMissionById(id, path);
  if (!mission) throw new Error(`Mission not found: ${id}`);
  if (mission.status !== "active") throw new Error(`Cannot fail mission with status "${mission.status}": ${id}`);
  await store.update(id, { status: "failed" }, path);
}

export async function reactivateMission(id: string, path?: string): Promise<void> {
  const mission = await findMissionById(id, path);
  if (!mission) throw new Error(`Mission not found: ${id}`);
  if (mission.status === "active") throw new Error(`Mission is already active: ${id}`);
  await store.update(id, { status: "active" }, path);
}

export async function loadMissionArchive(archivePath: string = DEFAULT_MISSION_ARCHIVE_PATH): Promise<Mission[]> {
  const archiveStore = new EntityStore<Mission>(archivePath, "Mission");
  return archiveStore.load();
}

export async function archiveMissions(
  ids: string[],
  path?: string,
  archivePath: string = DEFAULT_MISSION_ARCHIVE_PATH,
): Promise<Mission[]> {
  const missions = await loadMissions(path);
  const toArchive: Mission[] = [];

  for (const id of ids) {
    const mission = EntityStore.findByIdOrPrefix(missions, id);
    if (!mission) throw new Error(`Mission not found: ${id}`);
    if (mission.status === "active") throw new Error(`Cannot archive active mission: ${mission.name}`);
    toArchive.push(mission);
  }

  const remaining = missions.filter(m => !toArchive.includes(m));
  await saveMissions(remaining, path);

  await withLock(archivePath, async () => {
    const existing = await loadJsonFileUnlocked<Mission[]>(archivePath, []);
    await Bun.write(archivePath, JSON.stringify([...existing, ...toArchive], null, 2));
  });

  return toArchive;
}
