import { loadMissions } from "./mission";
import type { Mission } from "./mission";
import { TaskQueue } from "./queue";
import type { Task, OodaPhase } from "./task";
import { updateTask } from "./store";
import { runOnDoneHooks } from "./hooks";

export interface MissionRunnerOptions {
  pollIntervalMs?: number;
  idleTimeoutMs?: number;
  storePath?: string;
  missionsPath?: string;
}

export type IterationResult = "processed" | "idle" | "mission_completed";

export function findNextMissionTask(queue: TaskQueue, missionId: string): Task | undefined {
  const tasks = queue.getByMission(missionId);
  let best: Task | undefined;
  for (const task of tasks) {
    if (task.status !== "observing" || task.owner) continue;
    if (!best || task.priority > best.priority ||
        (task.priority === best.priority && task.createdAt < best.createdAt)) {
      best = task;
    }
  }
  return best;
}

function phaseLog(phase: OodaPhase, content: string) {
  return { phase, content, timestamp: new Date().toISOString() };
}

async function resolveMission(missionId: string, path?: string): Promise<Mission> {
  const missions = await loadMissions(path);
  const mission = missions.find(m => m.id === missionId || m.id.startsWith(missionId));
  if (!mission) throw new Error(`Mission not found: ${missionId}`);
  return mission;
}

export async function processTask(task: Task, mission: Mission, storePath?: string): Promise<void> {
  const principles = mission.principles.length > 0
    ? mission.principles.join("; ")
    : "none";
  const owner = `mission:${mission.name}`;

  // Claim — throws if already claimed or wrong status
  const claimed = await updateTask(task.id, (current) => {
    if (current.owner) throw new Error(`Already claimed by ${current.owner}`);
    if (current.status !== "observing") throw new Error(`Cannot process: status is ${current.status}`);
    return { owner };
  }, storePath);
  if (!claimed) throw new Error(`Task not found: ${task.id}`);

  try {
    // Observe
    await updateTask(task.id, (current) => ({
      logs: [...current.logs, phaseLog("observe", `Task: ${current.title}. Principles: ${principles}`)],
    }), storePath);

    // Orient
    await updateTask(task.id, (current) => ({
      status: "orienting" as const,
      logs: [...current.logs, phaseLog("orient", `Analysis for mission "${mission.name}"`)],
    }), storePath);

    // Decide
    await updateTask(task.id, (current) => ({
      status: "deciding" as const,
      logs: [...current.logs, phaseLog("decide", "Proceeding with execution")],
    }), storePath);

    // Act
    await updateTask(task.id, (current) => ({
      status: "acting" as const,
      logs: [...current.logs, phaseLog("act", "Executing")],
    }), storePath);

    // Done
    await updateTask(task.id, (current) => ({
      status: "done" as const,
      owner: undefined,
      logs: [...current.logs, phaseLog("act", "Completed by mission agent")],
    }), storePath);

    console.log(`Completed: ${task.title}`);
    await runOnDoneHooks(task.id, task.title);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateTask(task.id, (current) => ({
      status: "failed" as const,
      owner: undefined,
      logs: [...current.logs, phaseLog("act", `[FAILED] ${message}`)],
    }), storePath);
    console.error(`Failed: ${task.title} - ${message}`);
  }
}

export async function iterate(
  missionId: string,
  options: { storePath?: string; missionsPath?: string } = {},
): Promise<IterationResult> {
  const mission = await resolveMission(missionId, options.missionsPath);
  if (mission.status === "completed") return "mission_completed";

  const queue = new TaskQueue(options.storePath);
  await queue.load();

  const task = findNextMissionTask(queue, mission.id);
  if (!task) return "idle";

  await processTask(task, mission, options.storePath);
  return "processed";
}

export async function runMission(missionId: string, options: MissionRunnerOptions = {}): Promise<void> {
  const {
    pollIntervalMs = 30_000,
    idleTimeoutMs = 300_000,
    storePath,
    missionsPath,
  } = options;

  const mission = await resolveMission(missionId, missionsPath);
  console.log(`Mission agent started: ${mission.name}`);
  if (mission.principles.length > 0) {
    console.log(`Principles: ${mission.principles.join("; ")}`);
  }

  let idleSince: number | null = null;

  while (true) {
    let result: IterationResult;
    try {
      result = await iterate(mission.id, { storePath, missionsPath });
    } catch {
      // Transient error (e.g., claim race condition) — retry next iteration
      continue;
    }

    if (result === "mission_completed") {
      console.log(`Mission completed: ${mission.name}`);
      return;
    }

    if (result === "processed") {
      idleSince = null;
      continue;
    }

    // idle
    if (idleSince === null) {
      idleSince = Date.now();
    } else if (Date.now() - idleSince >= idleTimeoutMs) {
      console.log(`Idle timeout (${idleTimeoutMs / 1000}s), exiting`);
      return;
    }

    await Bun.sleep(pollIntervalMs);
  }
}
