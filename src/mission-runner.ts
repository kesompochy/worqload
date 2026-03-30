import { loadMissions, completeMission } from "./mission";
import type { Mission } from "./mission";
import { TaskQueue } from "./queue";
import type { Task, OodaPhase } from "./task";
import { createTask } from "./task";
import { updateTask, load, save } from "./store";
import { runOnDoneHooks } from "./hooks";
import { recordSpawnStart, recordSpawnFinish } from "./spawns";

export interface MissionRunnerOptions {
  pollIntervalMs?: number;
  idleTimeoutMs?: number;
  storePath?: string;
  missionsPath?: string;
  spawnCommand?: string[];
  spawnsPath?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  actCommand?: string[];
}

export type IterationResult = "processed" | "idle" | "mission_completed" | "spawned";

export interface SpawnCompletion {
  exitCode: number;
  output: string;
}

export interface SpawnResult {
  spawnId: string;
  pid: number;
  completion: Promise<SpawnCompletion>;
}

export interface ProcessTaskOptions {
  storePath?: string;
  actCommand?: string[];
  missionsPath?: string;
}

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

function isPlanTask(task: Task): boolean {
  return task.context.plan === true;
}

function buildActPrompt(task: Task, mission: Mission): string {
  const parts = [`Task: ${task.title}`];
  if (Object.keys(task.context).length > 0) {
    parts.push(`Context: ${JSON.stringify(task.context)}`);
  }
  parts.push(`Mission: ${mission.name}`);
  if (mission.principles.length > 0) {
    parts.push(`Principles:\n${mission.principles.map(p => `- ${p}`).join("\n")}`);
  }
  return parts.join("\n");
}

export async function processPlanTask(task: Task, mission: Mission, storePath?: string): Promise<void> {
  const owner = `mission:${mission.name}`;

  // Claim and read current context from store
  const claimed = await updateTask(task.id, (current) => {
    if (current.owner) throw new Error(`Already claimed by ${current.owner}`);
    if (current.status !== "observing") throw new Error(`Cannot process: status is ${current.status}`);
    return { owner };
  }, storePath);
  if (!claimed) throw new Error(`Task not found: ${task.id}`);

  const subtasks = claimed.context.subtasks;
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    await updateTask(task.id, () => ({ owner: undefined }), storePath);
    throw new Error(`Plan task ${task.id} has no subtasks`);
  }

  try {
    await updateTask(task.id, (current) => ({
      logs: [...current.logs, phaseLog("observe", `Plan: ${current.title}. Subtasks: ${subtasks.length}`)],
    }), storePath);

    await updateTask(task.id, (current) => ({
      status: "orienting" as const,
      logs: [...current.logs, phaseLog("orient", `Delegating to ${subtasks.length} subtasks for mission "${mission.name}"`)],
    }), storePath);

    await updateTask(task.id, (current) => ({
      status: "deciding" as const,
      logs: [...current.logs, phaseLog("decide", "Creating subtasks")],
    }), storePath);

    // Create subtasks and persist them atomically
    const newTasks = (subtasks as string[]).map(title => {
      const sub = createTask(title);
      sub.missionId = mission.id;
      return sub;
    });

    const allTasks = await load(storePath);
    allTasks.push(...newTasks);
    await save(allTasks, storePath);

    await updateTask(task.id, (current) => ({
      status: "done" as const,
      owner: undefined,
      logs: [...current.logs, phaseLog("act", `Delegated ${newTasks.length} subtask(s)`)],
    }), storePath);

    console.log(`Delegated: ${task.title} → ${newTasks.length} subtask(s)`);
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

export async function spawnTask(
  task: Task,
  mission: Mission,
  command: string[],
  options: { storePath?: string; spawnsPath?: string } = {},
): Promise<SpawnResult> {
  const { storePath, spawnsPath } = options;
  const owner = `mission:${mission.name}`;

  const claimed = await updateTask(task.id, (current) => {
    if (current.owner) throw new Error(`Already claimed by ${current.owner}`);
    if (current.status !== "observing") throw new Error(`Cannot spawn: status is ${current.status}`);
    return { owner };
  }, storePath);
  if (!claimed) throw new Error(`Task not found: ${task.id}`);

  const taskEnv: Record<string, string> = {
    WORQLOAD_TASK_ID: task.id,
    WORQLOAD_TASK_TITLE: task.title,
    WORQLOAD_TASK_CONTEXT: JSON.stringify(task.context),
  };

  if (mission.principles.length > 0) {
    taskEnv.WORQLOAD_MISSION_PRINCIPLES = mission.principles.join("\n");
  }

  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...taskEnv },
  });

  const spawnRecord = await recordSpawnStart(task.id, task.title, owner, proc.pid, spawnsPath);

  const completion = (async (): Promise<SpawnCompletion> => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    await recordSpawnFinish(spawnRecord.id, exitCode, spawnsPath);

    const output = (stdout + stderr).trim();
    const truncated = output.length > 2000 ? output.slice(-2000) : output;

    await updateTask(task.id, (current) => {
      const logs = [...current.logs, {
        phase: "act" as OodaPhase,
        content: truncated,
        timestamp: new Date().toISOString(),
      }];

      if (exitCode === 0) {
        return { status: "done" as const, logs, owner: undefined };
      } else {
        const failLogs = [...logs, {
          phase: "act" as OodaPhase,
          content: `[FAILED] exit code ${exitCode}`,
          timestamp: new Date().toISOString(),
        }];
        return { status: "failed" as const, logs: failLogs, owner: undefined };
      }
    }, storePath);

    if (exitCode === 0) {
      await runOnDoneHooks(task.id, task.title);
    }

    return { exitCode, output };
  })();

  return { spawnId: spawnRecord.id, pid: proc.pid, completion };
}

export async function processTask(task: Task, mission: Mission, options: ProcessTaskOptions = {}): Promise<void> {
  const { storePath, actCommand, missionsPath } = options;

  // Read current state from store to check plan flag
  const tasks = await load(storePath);
  const currentTask = tasks.find(t => t.id === task.id);
  if (currentTask && isPlanTask(currentTask)) {
    return processPlanTask(task, mission, storePath);
  }
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

    // Act — spawn agent process
    const prompt = buildActPrompt(claimed, mission);
    const command = [...(actCommand ?? ["claude", "-p"]), prompt];

    await updateTask(task.id, (current) => ({
      status: "acting" as const,
      logs: [...current.logs, phaseLog("act", `Spawning: ${command[0]}`)],
    }), storePath);

    const proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const output = (stdout + stderr).trim();
    const truncated = output.length > 2000 ? output.slice(-2000) : output;

    if (exitCode === 0) {
      await updateTask(task.id, (current) => ({
        status: "done" as const,
        owner: undefined,
        logs: [...current.logs, phaseLog("act", truncated)],
      }), storePath);
      console.log(`Completed: ${task.title}`);
      await runOnDoneHooks(task.id, task.title);
    } else {
      await updateTask(task.id, (current) => ({
        status: "failed" as const,
        owner: undefined,
        logs: [...current.logs,
          phaseLog("act", truncated),
          phaseLog("act", `[FAILED] exit code ${exitCode}`),
        ],
      }), storePath);
      console.error(`Failed: ${task.title} - exit code ${exitCode}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateTask(task.id, (current) => ({
      status: "failed" as const,
      owner: undefined,
      logs: [...current.logs, phaseLog("act", `[FAILED] ${message}`)],
    }), storePath);
    console.error(`Failed: ${task.title} - ${message}`);
  }

  // Auto-complete mission if all tasks are terminal
  try {
    const queue = new TaskQueue(storePath);
    await queue.load();
    const missionTasks = queue.getByMission(mission.id);
    const allTerminal = missionTasks.length > 0 &&
      missionTasks.every(t => t.status === "done" || t.status === "failed");
    if (allTerminal) {
      await completeMission(mission.id, missionsPath);
    }
  } catch {
    // Best-effort: mission may already be completed by another runner
  }
}

// Per-mission OODA: picks the next unclaimed task for a specific mission and
// processes or spawns it. Called in a loop by runMission().
// Contrast with commands/iterate.ts iterate(), which is the queue-wide iteration
// that surveys all tasks across all missions.
export async function iterateMission(
  missionId: string,
  options: { storePath?: string; missionsPath?: string; spawnCommand?: string[]; spawnsPath?: string; actCommand?: string[] } = {},
): Promise<IterationResult> {
  const mission = await resolveMission(missionId, options.missionsPath);
  if (mission.status === "completed") return "mission_completed";

  const queue = new TaskQueue(options.storePath);
  await queue.load();

  const task = findNextMissionTask(queue, mission.id);
  if (!task) {
    const missionTasks = queue.getByMission(mission.id);
    const allTerminal = missionTasks.length > 0 &&
      missionTasks.every(t => t.status === "done" || t.status === "failed");
    if (allTerminal) {
      await completeMission(mission.id, options.missionsPath);
      return "mission_completed";
    }
    return "idle";
  }

  if (options.spawnCommand && !isPlanTask(task)) {
    const spawn = await spawnTask(task, mission, options.spawnCommand, {
      storePath: options.storePath,
      spawnsPath: options.spawnsPath,
    });
    await spawn.completion;
    return "spawned";
  }

  await processTask(task, mission, { storePath: options.storePath, actCommand: options.actCommand, missionsPath: options.missionsPath });
  return "processed";
}

export async function runMission(missionId: string, options: MissionRunnerOptions = {}): Promise<void> {
  const {
    pollIntervalMs = 30_000,
    idleTimeoutMs = 300_000,
    maxRetries = 5,
    retryBaseMs = 1000,
    storePath,
    missionsPath,
    spawnCommand,
    spawnsPath,
    actCommand,
  } = options;

  const mission = await resolveMission(missionId, missionsPath);
  console.log(`Mission agent started: ${mission.name}`);
  if (mission.principles.length > 0) {
    console.log(`Principles: ${mission.principles.join("; ")}`);
  }

  let idleSince: number | null = null;
  let consecutiveErrors = 0;
  let lastError: Error | undefined;

  while (true) {
    let result: IterationResult;
    try {
      result = await iterateMission(mission.id, { storePath, missionsPath, spawnCommand, spawnsPath, actCommand });
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors++;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (consecutiveErrors >= maxRetries) {
        throw new Error(`Retry limit reached (${maxRetries}): ${lastError.message}`);
      }
      await Bun.sleep(retryBaseMs * Math.pow(2, consecutiveErrors - 1));
      continue;
    }

    if (result === "mission_completed") {
      console.log(`Mission completed: ${mission.name}`);
      return;
    }

    if (result === "processed" || result === "spawned") {
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
