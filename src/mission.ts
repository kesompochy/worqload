import { loadJsonFile, saveJsonFile } from "./utils/json-store";

const DEFAULT_MISSIONS_PATH = ".worqload/missions.json";

export type MissionStatus = "active" | "completed";

export interface MissionFilter {
  tags?: string[];
}

export interface Mission {
  id: string;
  name: string;
  filter: MissionFilter;
  principles: string[];
  status: MissionStatus;
  createdAt: string;
}

export async function loadMissions(path: string = DEFAULT_MISSIONS_PATH): Promise<Mission[]> {
  return loadJsonFile<Mission[]>(path, []);
}

export async function saveMissions(missions: Mission[], path: string = DEFAULT_MISSIONS_PATH): Promise<void> {
  await saveJsonFile(path, missions);
}

export async function createMission(name: string, filter: MissionFilter = {}, path: string = DEFAULT_MISSIONS_PATH): Promise<Mission> {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("Mission name must not be empty");
  }
  const mission: Mission = {
    id: crypto.randomUUID(),
    name: trimmed,
    filter,
    principles: [],
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

export async function completeMission(id: string, path: string = DEFAULT_MISSIONS_PATH): Promise<void> {
  const missions = await loadMissions(path);
  const mission = missions.find(m => m.id === id || m.id.startsWith(id));
  if (!mission) throw new Error(`Mission not found: ${id}`);
  if (mission.status === "completed") throw new Error(`Mission is already completed: ${id}`);
  mission.status = "completed";
  await saveMissions(missions, path);
}
