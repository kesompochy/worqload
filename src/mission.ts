import { loadJsonFile, saveJsonFile } from "./utils/json-store";

const DEFAULT_MISSIONS_PATH = ".worqload/missions.json";

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

export async function loadMissions(path: string = DEFAULT_MISSIONS_PATH): Promise<Mission[]> {
  const missions = await loadJsonFile<Mission[]>(path, []);
  return missions.map(m => ({ priority: 0, ...m }));
}

export async function saveMissions(missions: Mission[], path: string = DEFAULT_MISSIONS_PATH): Promise<void> {
  await saveJsonFile(path, missions);
}

export async function createMission(name: string, filter: MissionFilter = {}, path: string = DEFAULT_MISSIONS_PATH, priority = 0): Promise<Mission> {
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
  const missions = await loadMissions(path);
  missions.push(mission);
  await saveMissions(missions, path);
  return mission;
}

export async function addMissionPrinciple(id: string, text: string, path: string = DEFAULT_MISSIONS_PATH): Promise<void> {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error("Principle text must not be empty");
  }
  const missions = await loadMissions(path);
  const mission = missions.find(m => m.id === id || m.id.startsWith(id));
  if (!mission) throw new Error(`Mission not found: ${id}`);
  if (!mission.principles) mission.principles = [];
  mission.principles.push(trimmed);
  await saveMissions(missions, path);
}

export async function removeMissionPrinciple(id: string, index: number, path: string = DEFAULT_MISSIONS_PATH): Promise<void> {
  const missions = await loadMissions(path);
  const mission = missions.find(m => m.id === id || m.id.startsWith(id));
  if (!mission) throw new Error(`Mission not found: ${id}`);
  const principles = mission.principles || [];
  if (index < 0 || index >= principles.length) {
    throw new Error(`Principle index out of range: ${index}`);
  }
  principles.splice(index, 1);
  await saveMissions(missions, path);
}

export async function completeMission(id: string, path: string = DEFAULT_MISSIONS_PATH): Promise<void> {
  const missions = await loadMissions(path);
  const mission = missions.find(m => m.id === id || m.id.startsWith(id));
  if (!mission) throw new Error(`Mission not found: ${id}`);
  if (mission.status === "completed") throw new Error(`Mission is already completed: ${id}`);
  mission.status = "completed";
  await saveMissions(missions, path);
}

export async function failMission(id: string, path: string = DEFAULT_MISSIONS_PATH): Promise<void> {
  const missions = await loadMissions(path);
  const mission = missions.find(m => m.id === id || m.id.startsWith(id));
  if (!mission) throw new Error(`Mission not found: ${id}`);
  if (mission.status !== "active") throw new Error(`Cannot fail mission with status "${mission.status}": ${id}`);
  mission.status = "failed";
  await saveMissions(missions, path);
}

export async function reactivateMission(id: string, path: string = DEFAULT_MISSIONS_PATH): Promise<void> {
  const missions = await loadMissions(path);
  const mission = missions.find(m => m.id === id || m.id.startsWith(id));
  if (!mission) throw new Error(`Mission not found: ${id}`);
  if (mission.status === "active") throw new Error(`Mission is already active: ${id}`);
  mission.status = "active";
  await saveMissions(missions, path);
}
