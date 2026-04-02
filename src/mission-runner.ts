import { findMissionById, completeMission, failMission } from "./mission";
import type { Mission } from "./mission";
import { TaskQueue } from "./queue";
import type { Task } from "./task";
import { createTask, ESCALATION_EXIT_CODE, HUMAN_REQUIRED_PREFIX, isEligible, isTerminal } from "./task";
import { updateTask, load, save } from "./store";
import { runOnDoneHooks } from "./hooks";
import { registerRunner, heartbeatRunner, deregisterRunner } from "./mission-runner-state";
import { createWorktree, mergeWorktreeBranch, removeWorktree } from "./worktree";
import { orientTask, shouldForceEscalation, ORIENT_ESCALATION_WINDOW } from "./mission-runner-orient";
import type { OrientResult } from "./mission-runner-orient";
import { buildActPrompt, ensureReportForDoneTask, isPlanTask, isReportToHumanTask, REPORT_HUMAN_PREFIX } from "./mission-runner-act";
import type { EnsureReportOptions } from "./mission-runner-act";
import { spawnWithTimeout, SpawnTimeoutError, DEFAULT_SPAWN_TIMEOUT_MS, killProcessTree, buildTaskEnv, truncateOutput } from "./spawn-executor";
import { loadConfig } from "./config";
import type { SpawnWithTimeoutResult } from "./spawn-executor";
import { MAX_TASK_RETRIES, RETRY_BASE_MS, canRetry, computeRetryUpdate, phaseLog } from "./mission-runner-retry";
import type { RetryUpdate } from "./mission-runner-retry";
import { spawnTask } from "./mission-runner-spawn";

// Re-export sub-module APIs for backward compatibility
export { orientTask, shouldForceEscalation, ORIENT_ESCALATION_WINDOW } from "./mission-runner-orient";
export type { OrientResult } from "./mission-runner-orient";
export { buildActPrompt, ensureReportForDoneTask, isPlanTask, isReportToHumanTask, REPORT_HUMAN_PREFIX } from "./mission-runner-act";
export type { EnsureReportOptions } from "./mission-runner-act";
export { spawnWithTimeout, SpawnTimeoutError, DEFAULT_SPAWN_TIMEOUT_MS, killProcessTree, buildTaskEnv, truncateOutput } from "./spawn-executor";
export type { SpawnWithTimeoutResult } from "./spawn-executor";
export { MAX_TASK_RETRIES, RETRY_BASE_MS, canRetry, computeRetryUpdate, phaseLog } from "./mission-runner-retry";
export type { RetryUpdate } from "./mission-runner-retry";
export { spawnTask } from "./mission-runner-spawn";
export type { SpawnCompletion, SpawnResult } from "./mission-runner-spawn";

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
  runnerStatePath?: string;
  spawnTimeoutMs?: number;
  reportsPath?: string;
  useWorktree?: boolean;
}

export type IterationResult = "processed" | "idle" | "mission_completed" | "mission_failed" | "spawned";

export interface ProcessTaskOptions {
  storePath?: string;
  actCommand?: string[];
  missionsPath?: string;
  spawnTimeoutMs?: number;
  reportsPath?: string;
  useWorktree?: boolean;
}

export function shouldUseWorktreeForTask(
  context: Record<string, unknown>,
  globalUseWorktree: boolean,
): boolean {
  if (context.worktreeDisabled) return false;
  if (typeof context.useWorktree === "boolean") return context.useWorktree;
  return globalUseWorktree;
}

export function findAllEligibleTasks(queue: TaskQueue, missionId: string): Task[] {
  return queue.getByMission(missionId)
    .filter(isEligible)
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}

export function findNextMissionTask(queue: TaskQueue, missionId: string): Task | undefined {
  const tasks = queue.getByMission(missionId);
  let best: Task | undefined;
  for (const task of tasks) {
    if (!isEligible(task)) continue;
    if (!best || task.priority > best.priority ||
        (task.priority === best.priority && task.createdAt < best.createdAt)) {
      best = task;
    }
  }
  return best;
}

async function resolveMission(missionId: string, path?: string): Promise<Mission> {
  const mission = await findMissionById(missionId, path);
  if (!mission) throw new Error(`Mission not found: ${missionId}`);
  return mission;
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

export async function processTask(task: Task, mission: Mission, options: ProcessTaskOptions = {}): Promise<void> {
  const { storePath, actCommand, missionsPath, spawnTimeoutMs = DEFAULT_SPAWN_TIMEOUT_MS, reportsPath, useWorktree } = options;

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
    if (current.status !== "observing" && current.status !== "orienting") throw new Error(`Cannot process: status is ${current.status}`);
    return { owner };
  }, storePath);
  if (!claimed) throw new Error(`Task not found: ${task.id}`);

  const alreadyOriented = claimed.status === "orienting";

  try {
    if (!alreadyOriented) {
      // Observe
      await updateTask(task.id, (current) => ({
        logs: [...current.logs, phaseLog("observe", `Task: ${current.title}. Principles: ${principles}`)],
      }), storePath);

      // Orient — validate task against mission principles
      const orientResult = await orientTask(task.id, mission, storePath);
      if (orientResult === "escalated" || orientResult === "needs_principles") {
        await updateTask(task.id, (current) => ({ owner: undefined }), storePath);
        return;
      }
    }

    // Decide
    await updateTask(task.id, (current) => ({
      status: "deciding" as const,
      logs: [...current.logs, phaseLog("decide", "Proceeding with execution")],
    }), storePath);

    // Act — spawn agent process, optionally in a git worktree for isolation
    let worktreeInfo: { worktreePath: string; branchName: string } | undefined;
    if (shouldUseWorktreeForTask(claimed.context, useWorktree ?? false)) {
      try {
        worktreeInfo = await createWorktree(task.id);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Worktree creation failed, falling back to main tree: ${msg}`);
      }
    }

    const prompt = buildActPrompt(claimed, mission);
    const config = await loadConfig();
    const maxTurns = String(config.spawn?.maxTurns ?? 30);
    const command = [...(actCommand ?? ["claude", "-p", "--max-turns", maxTurns]), prompt];

    const spawnCwd = worktreeInfo?.worktreePath;
    await updateTask(task.id, (current) => ({
      status: "acting" as const,
      logs: [...current.logs, phaseLog("act", `Spawning: ${command[0]}${spawnCwd ? ` (worktree: ${worktreeInfo!.branchName})` : ""}`)],
    }), storePath);

    const taskEnv = buildTaskEnv({
      taskId: task.id,
      taskTitle: task.title,
      taskContext: claimed.context,
      missionPrinciples: mission.principles,
    });

    let spawnResult: SpawnWithTimeoutResult;
    try {
      spawnResult = await spawnWithTimeout(command, { ...process.env, ...taskEnv }, spawnTimeoutMs, spawnCwd);
    } catch (error) {
      if (error instanceof SpawnTimeoutError) {
        if (canRetry(claimed.context) && !isReportToHumanTask(task)) {
          const { retryCount, retryAfter } = computeRetryUpdate(claimed.context);
          await updateTask(task.id, (current) => ({
            status: "observing" as const,
            owner: undefined,
            context: { ...current.context, retryCount, retryAfter },
            logs: [...current.logs, phaseLog("act", `[TIMEOUT] Spawn timed out after ${spawnTimeoutMs}ms`)],
          }), storePath);
          console.log(`Timeout retry ${retryCount}/${MAX_TASK_RETRIES}: ${task.title}`);
        } else {
          await updateTask(task.id, (current) => ({
            status: "failed" as const,
            owner: undefined,
            logs: [...current.logs,
              phaseLog("act", `[TIMEOUT] Spawn timed out after ${spawnTimeoutMs}ms`),
              phaseLog("act", `[FAILED] timeout after ${MAX_TASK_RETRIES} retries`),
            ],
          }), storePath);
          console.error(`Failed (timeout): ${task.title}`);
        }
        return;
      }
      throw error;
    }

    const { stdout, stderr, exitCode } = spawnResult;
    const output = (stdout + stderr).trim();
    const truncated = truncateOutput(output);

    // Merge worktree changes back to main before updating task status
    let mergeConflicted = false;
    if (worktreeInfo) {
      try {
        const merged = await mergeWorktreeBranch(worktreeInfo.branchName);
        if (merged) {
          await removeWorktree(worktreeInfo.worktreePath, worktreeInfo.branchName);
        } else {
          mergeConflicted = true;
          console.error(`Merge conflict on ${worktreeInfo.branchName}, changes preserved in worktree`);
        }
      } catch (error) {
        mergeConflicted = true;
        console.error(`Worktree merge failed: ${error instanceof Error ? error.message : error}`);
      }
    }

    if (mergeConflicted) {
      await updateTask(task.id, (current) => ({
        status: "observing" as const,
        owner: undefined,
        context: { ...current.context, worktreeDisabled: true },
        logs: [...current.logs,
          phaseLog("act", truncated),
          phaseLog("act", `[MERGE_CONFLICT] ${worktreeInfo!.branchName} — retrying without worktree`),
        ],
      }), storePath);
      return;
    }

    if (exitCode === 0) {
      await updateTask(task.id, (current) => ({
        status: "done" as const,
        owner: undefined,
        logs: [...current.logs, phaseLog("act", truncated)],
      }), storePath);
      console.log(`Completed: ${task.title}`);
      await runOnDoneHooks(task.id, task.title);
      const doneTask = (await load(storePath)).find(t => t.id === task.id);
      if (doneTask) {
        await ensureReportForDoneTask(doneTask, mission.name, { reportsPath });
      }
    } else if (exitCode === ESCALATION_EXIT_CODE) {
      const question = truncated || "Spawned agent requested human escalation";
      await updateTask(task.id, (current) => ({
        status: "waiting_human" as const,
        owner: undefined,
        logs: [...current.logs,
          phaseLog("act", truncated),
          phaseLog("orient", `${HUMAN_REQUIRED_PREFIX}${question}`),
        ],
      }), storePath);
      console.log(`Escalated: ${task.title}`);
    } else {
      if (!isReportToHumanTask(claimed) && canRetry(claimed.context)) {
        const { retryCount, retryAfter } = computeRetryUpdate(claimed.context);
        const disableWorktree = !!worktreeInfo;
        await updateTask(task.id, (current) => ({
          status: "observing" as const,
          owner: undefined,
          context: { ...current.context, retryCount, retryAfter, ...(disableWorktree ? { worktreeDisabled: true } : {}) },
          logs: [...current.logs,
            phaseLog("act", truncated),
            phaseLog("act", `[RETRY] ${retryCount}/${MAX_TASK_RETRIES} - exit code ${exitCode}${disableWorktree ? " (worktree disabled for retry)" : ""}`),
          ],
        }), storePath);
        if (disableWorktree) {
          console.log(`Worktree disabled for retry: ${task.title}`);
        }
        console.log(`Retry ${retryCount}/${MAX_TASK_RETRIES}: ${task.title}`);
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
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (canRetry(claimed.context)) {
      const { retryCount, retryAfter } = computeRetryUpdate(claimed.context);
      await updateTask(task.id, (current) => ({
        status: "observing" as const,
        owner: undefined,
        context: { ...current.context, retryCount, retryAfter },
        logs: [...current.logs, phaseLog("act", `[RETRY] ${retryCount}/${MAX_TASK_RETRIES} - ${message}`)],
      }), storePath);
      console.log(`Retry ${retryCount}/${MAX_TASK_RETRIES}: ${task.title}`);
    } else {
      await updateTask(task.id, (current) => ({
        status: "failed" as const,
        owner: undefined,
        logs: [...current.logs, phaseLog("act", `[FAILED] ${message}`)],
      }), storePath);
      console.error(`Failed: ${task.title} - ${message}`);
    }
  }

  // Finalize mission if all tasks are terminal
  try {
    const queue = new TaskQueue(storePath);
    await queue.load();
    const missionTasks = queue.getByMission(mission.id);
    const allTerminal = missionTasks.length > 0 &&
      missionTasks.every(isTerminal);
    if (allTerminal) {
      const hasFailed = missionTasks.some(t => t.status === "failed");
      if (hasFailed) {
        await failMission(mission.id, missionsPath);
      } else {
        await completeMission(mission.id, missionsPath);
      }
    }
  } catch {
    // Best-effort: mission may already be completed/failed by another runner
  }
}

// Per-mission OODA: picks the next unclaimed task for a specific mission and
// processes or spawns it. Called in a loop by runMission().
// Contrast with commands/iterate.ts iterate(), which is the queue-wide iteration
// that surveys all tasks across all missions.
export async function iterateMission(
  missionId: string,
  options: { storePath?: string; missionsPath?: string; spawnCommand?: string[]; spawnsPath?: string; actCommand?: string[]; spawnTimeoutMs?: number; reportsPath?: string; useWorktree?: boolean } = {},
): Promise<IterationResult> {
  const mission = await resolveMission(missionId, options.missionsPath);
  if (mission.status === "completed") return "mission_completed";
  if (mission.status === "failed") return "mission_failed";

  const queue = new TaskQueue(options.storePath);
  await queue.load();

  const task = findNextMissionTask(queue, mission.id);
  if (!task) {
    const missionTasks = queue.getByMission(mission.id);
    const allTerminal = missionTasks.length > 0 &&
      missionTasks.every(isTerminal);
    if (allTerminal) {
      const hasFailed = missionTasks.some(t => t.status === "failed");
      if (hasFailed) {
        await failMission(mission.id, options.missionsPath);
        return "mission_failed";
      }
      await completeMission(mission.id, options.missionsPath);
      return "mission_completed";
    }
    return "idle";
  }

  if (options.spawnCommand && !isPlanTask(task)) {
    const spawn = await spawnTask(task, mission, options.spawnCommand, {
      storePath: options.storePath,
      spawnsPath: options.spawnsPath,
      spawnTimeoutMs: options.spawnTimeoutMs,
      reportsPath: options.reportsPath,
    });
    await spawn.completion;
    return "spawned";
  }

  await processTask(task, mission, { storePath: options.storePath, actCommand: options.actCommand, missionsPath: options.missionsPath, spawnTimeoutMs: options.spawnTimeoutMs, reportsPath: options.reportsPath, useWorktree: options.useWorktree });
  return "processed";
}

export async function runMission(missionId: string, options: MissionRunnerOptions = {}): Promise<void> {
  const {
    pollIntervalMs = 30_000,
    idleTimeoutMs = 1_800_000,
    maxRetries = 5,
    retryBaseMs = 1000,
    storePath,
    missionsPath,
    spawnCommand,
    spawnsPath,
    actCommand,
    runnerStatePath,
    spawnTimeoutMs,
    reportsPath,
    useWorktree,
  } = options;

  // Survive terminal closure when running as a daemon
  const sighupHandler = () => {};
  process.on("SIGHUP", sighupHandler);

  const mission = await resolveMission(missionId, missionsPath);
  if (mission.principles.length === 0) {
    console.error(`Mission "${mission.name}" has no principles. Main session must set principles using: worqload mission principle ${mission.id} add <text>`);
    return;
  }
  console.log(`Mission agent started: ${mission.name}`);
  console.log(`Principles: ${mission.principles.join("; ")}`);

  const runnerState = await registerRunner(mission.id, mission.name, process.pid, runnerStatePath);

  let idleSince: number | null = null;
  let consecutiveErrors = 0;
  let consecutiveIdles = 0;
  let tasksProcessed = 0;
  let lastError: Error | undefined;

  try {
    while (true) {
      let result: IterationResult;
      try {
        // Find next task to report what we're working on
        const queue = new TaskQueue(storePath);
        await queue.load();
        const nextTask = findNextMissionTask(queue, mission.id);

        await heartbeatRunner(runnerState.id, {
          status: "running",
          currentTaskId: nextTask?.id,
          currentTaskTitle: nextTask?.title,
          consecutiveIdles,
          tasksProcessed,
        }, runnerStatePath);

        {
          // Parallel: when multiple eligible tasks have worktree enabled
          // (per-task context or global option), process them concurrently
          const iterQueue = new TaskQueue(storePath);
          await iterQueue.load();
          const eligible = findAllEligibleTasks(iterQueue, mission.id);
          const worktreeEligible = eligible.filter(t =>
            shouldUseWorktreeForTask(t.context, useWorktree ?? false));
          if (worktreeEligible.length > 1) {
            const missionObj = await resolveMission(mission.id, missionsPath);
            const promises = worktreeEligible.map(t =>
              processTask(t, missionObj, { storePath, actCommand, missionsPath, spawnTimeoutMs, reportsPath, useWorktree })
                .catch(err => console.error(`Parallel task failed: ${t.title.slice(0, 40)} - ${err}`))
            );
            await Promise.all(promises);
            result = "processed";
          } else {
            result = await iterateMission(mission.id, { storePath, missionsPath, spawnCommand, spawnsPath, actCommand, spawnTimeoutMs, reportsPath, useWorktree });
          }
        }
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

      if (result === "mission_failed") {
        console.log(`Mission failed: ${mission.name}`);
        return;
      }

      if (result === "processed" || result === "spawned") {
        idleSince = null;
        consecutiveIdles = 0;
        tasksProcessed++;
        continue;
      }

      // idle
      consecutiveIdles++;
      await heartbeatRunner(runnerState.id, {
        status: "idle",
        currentTaskId: undefined,
        currentTaskTitle: undefined,
        consecutiveIdles,
        tasksProcessed,
      }, runnerStatePath);

      if (idleSince === null) {
        idleSince = Date.now();
      } else if (Date.now() - idleSince >= idleTimeoutMs) {
        console.log(`Idle timeout (${idleTimeoutMs / 1000}s), exiting`);
        return;
      }

      await Bun.sleep(pollIntervalMs);
    }
  } finally {
    process.removeListener("SIGHUP", sighupHandler);
    await deregisterRunner(runnerState.id, runnerStatePath);
  }
}
