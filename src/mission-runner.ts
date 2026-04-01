import { loadMissions, completeMission, failMission } from "./mission";
import type { Mission } from "./mission";
import { TaskQueue } from "./queue";
import type { Task, OodaPhase } from "./task";
import { createTask, HUMAN_REQUIRED_PREFIX, ESCALATION_EXIT_CODE } from "./task";
import { updateTask, load, save } from "./store";
import { runOnDoneHooks } from "./hooks";
import { recordSpawnStart, recordSpawnFinish } from "./spawns";
import { registerRunner, heartbeatRunner, deregisterRunner } from "./mission-runner-state";
import { loadReports, addReport, isVacuousContent } from "./reports";
import { createWorktree, mergeWorktreeBranch, removeWorktree } from "./worktree";

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
  spawnTimeoutMs?: number;
  reportsPath?: string;
  useWorktree?: boolean;
}

const MAX_TASK_RETRIES = 2;
const RETRY_BASE_MS = 1000;
const DEFAULT_SPAWN_TIMEOUT_MS = 30 * 60 * 1000;

class SpawnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Spawn timed out after ${timeoutMs}ms`);
    this.name = "SpawnTimeoutError";
  }
}

interface SpawnWithTimeoutResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function killProcessTree(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}

async function spawnWithTimeout(
  command: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
  cwd?: string,
): Promise<SpawnWithTimeoutResult> {
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env,
    ...(cwd ? { cwd } : {}),
  });

  console.log(`[spawn] PID ${proc.pid} started: ${command[0]} (timeout: ${Math.round(timeoutMs / 1000)}s${cwd ? `, cwd: ${cwd}` : ""})`);

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      console.log(`[spawn] PID ${proc.pid} timed out after ${Math.round(timeoutMs / 1000)}s`);
      killProcessTree(proc.pid);
      reject(new SpawnTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  const completionPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    console.log(`[spawn] PID ${proc.pid} exited: code=${exitCode}, stdout=${stdout.length}B, stderr=${stderr.length}B`);
    return { stdout, stderr, exitCode };
  })();

  return Promise.race([completionPromise, timeoutPromise]);
}

export function findAllEligibleTasks(queue: TaskQueue, missionId: string): Task[] {
  const tasks = queue.getByMission(missionId);
  return tasks
    .filter(t => (t.status === "observing" || t.status === "orienting") && !t.owner)
    .filter(t => !t.context.retryAfter || new Date(t.context.retryAfter as string) <= new Date())
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}

export function findNextMissionTask(queue: TaskQueue, missionId: string): Task | undefined {
  const tasks = queue.getByMission(missionId);
  let best: Task | undefined;
  for (const task of tasks) {
    if ((task.status !== "observing" && task.status !== "orienting") || task.owner) continue;
    if (task.context.retryAfter && new Date(task.context.retryAfter as string) > new Date()) continue;
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

function formatContextForOrient(context: Record<string, unknown>): string {
  const keys = Object.keys(context);
  if (keys.length === 0) return "";
  const parts: string[] = [];
  if (Array.isArray(context.observations)) {
    parts.push(context.observations.join("; "));
  }
  if (typeof context.feedbackId === "string") {
    parts.push(`feedback: ${context.feedbackId}`);
  }
  if (Array.isArray(context.feedbackIds)) {
    parts.push(`feedback: ${context.feedbackIds.join(", ")}`);
  }
  if (Array.isArray(context.principles)) {
    parts.push(`principles: ${context.principles.join(", ")}`);
  }
  if (parts.length === 0) {
    return JSON.stringify(context);
  }
  return parts.join("; ");
}

export interface EnsureReportOptions {
  reportsPath?: string;
}

export async function ensureReportForDoneTask(
  task: Task,
  missionName: string,
  options: EnsureReportOptions = {},
): Promise<void> {
  const { reportsPath } = options;

  const reports = await loadReports(reportsPath);
  const existingReport = reports.find(r => r.taskId === task.id);
  if (existingReport) return;

  const actLogs = task.logs
    .filter(l => l.phase === "act")
    .map(l => l.content)
    .filter(c => !c.startsWith("[RETRY]") && !c.startsWith("[FAILED]") && !c.startsWith("[TIMEOUT]"));

  const substantiveLogs = actLogs.filter(c => !isVacuousContent(c));
  if (substantiveLogs.length === 0) return;

  await addReport(task.title, substantiveLogs.join("\n\n"), `mission:${missionName}`, {
    taskId: task.id,
    path: reportsPath,
  });
}

export type OrientResult = "oriented" | "escalated";

export const ORIENT_ESCALATION_WINDOW = 5;

export function shouldForceEscalation(missionTasks: Task[], window: number = ORIENT_ESCALATION_WINDOW): boolean {
  const terminalTasks = missionTasks
    .filter(t => t.status === "done" || t.status === "failed")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  if (terminalTasks.length < window) return false;

  const recentTasks = terminalTasks.slice(0, window);
  const hasEscalation = recentTasks.some(t =>
    t.logs.some(l => l.phase === "orient" && l.content.includes(HUMAN_REQUIRED_PREFIX)));

  return !hasEscalation;
}

export async function orientTask(
  taskId: string,
  mission: Mission,
  storePath?: string,
): Promise<OrientResult> {
  if (mission.principles.length === 0) {
    await updateTask(taskId, (current) => ({
      status: "waiting_human" as const,
      logs: [...current.logs, phaseLog("orient",
        `${HUMAN_REQUIRED_PREFIX}Mission "${mission.name}" has no principles defined. Human guidance needed to orient task.`)],
    }), storePath);
    return "escalated";
  }

  // Orient requires human expertise — force periodic escalation
  // Skip if this task already has a human answer (avoid re-escalation loop)
  const allTasks = await load(storePath);
  const currentTask = allTasks.find(t => t.id === taskId);
  const alreadyHasHumanAnswer = currentTask?.logs.some(
    l => l.phase === "orient" && !l.content.startsWith(HUMAN_REQUIRED_PREFIX),
  );
  const missionTasks = allTasks.filter(t => t.missionId === mission.id && t.id !== taskId);
  if (!alreadyHasHumanAnswer && shouldForceEscalation(missionTasks)) {
    await updateTask(taskId, (current) => ({
      status: "waiting_human" as const,
      logs: [...current.logs, phaseLog("orient",
        `${HUMAN_REQUIRED_PREFIX}Mission "${mission.name}": orient requires human expertise. No human-reviewed orient in recent ${ORIENT_ESCALATION_WINDOW} completed tasks.`)],
    }), storePath);
    return "escalated";
  }

  const principlesList = mission.principles.map(p => `- ${p}`).join("\n");
  await updateTask(taskId, (current) => {
    const taskTitle = current.title;
    const contextSummary = formatContextForOrient(current.context);
    const orientLines = [
      `Mission "${mission.name}" orient:`,
      `Task: ${taskTitle}`,
    ];
    if (contextSummary) {
      orientLines.push(`Context: ${contextSummary}`);
    }
    orientLines.push(`Principles:\n${principlesList}`);
    return {
      status: "orienting" as const,
      logs: [...current.logs, phaseLog("orient", orientLines.join("\n"))],
    };
  }, storePath);
  return "oriented";
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
  parts.push(`\nInstructions:\n- Use $WORQLOAD_CLI to interact with worqload (e.g. $WORQLOAD_CLI report add $WORQLOAD_TASK_ID "title" "content")\n- Write tests first (TDD), then implement\n- Commit your changes when done\n- Keep scope small — one commit-sized unit of work\n- Reports must be in Japanese`);
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
  options: { storePath?: string; spawnsPath?: string; spawnTimeoutMs?: number; reportsPath?: string } = {},
): Promise<SpawnResult> {
  const { storePath, spawnsPath, spawnTimeoutMs = DEFAULT_SPAWN_TIMEOUT_MS, reportsPath } = options;
  const owner = `mission:${mission.name}`;

  const claimed = await updateTask(task.id, (current) => {
    if (current.owner) throw new Error(`Already claimed by ${current.owner}`);
    if (current.status !== "observing") throw new Error(`Cannot spawn: status is ${current.status}`);
    return { owner };
  }, storePath);
  if (!claimed) throw new Error(`Task not found: ${task.id}`);

  const taskEnv: Record<string, string> = {
    WORQLOAD_CLI: "worqload",
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
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc.pid);
    }, spawnTimeoutMs);

    try {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      clearTimeout(timeoutId);

      await recordSpawnFinish(spawnRecord.id, exitCode, spawnsPath);

      const output = (stdout + stderr).trim();
      const truncated = output.length > 2000 ? output.slice(-2000) : output;

      if (timedOut) {
        await updateTask(task.id, (current) => {
          const retryCount = (current.context.retryCount as number) || 0;
          if (retryCount < MAX_TASK_RETRIES) {
            const newRetryCount = retryCount + 1;
            const retryAfter = new Date(Date.now() + RETRY_BASE_MS * Math.pow(2, retryCount)).toISOString();
            return {
              status: "observing" as const,
              owner: undefined,
              context: { ...current.context, retryCount: newRetryCount, retryAfter },
              logs: [...current.logs, {
                phase: "act" as OodaPhase,
                content: `[TIMEOUT] Spawn timed out after ${spawnTimeoutMs}ms`,
                timestamp: new Date().toISOString(),
              }],
            };
          } else {
            return {
              status: "failed" as const,
              owner: undefined,
              logs: [...current.logs, {
                phase: "act" as OodaPhase,
                content: `[TIMEOUT] Spawn timed out after ${spawnTimeoutMs}ms`,
                timestamp: new Date().toISOString(),
              }, {
                phase: "act" as OodaPhase,
                content: `[FAILED] timeout after ${MAX_TASK_RETRIES} retries`,
                timestamp: new Date().toISOString(),
              }],
            };
          }
        }, storePath);
        return { exitCode, output };
      }

      await updateTask(task.id, (current) => {
        const logs = [...current.logs, {
          phase: "act" as OodaPhase,
          content: truncated,
          timestamp: new Date().toISOString(),
        }];

        if (exitCode === 0) {
          return { status: "done" as const, logs, owner: undefined };
        } else if (exitCode === ESCALATION_EXIT_CODE) {
          const question = truncated || "Spawned agent requested human escalation";
          const escalationLogs = [...logs, {
            phase: "orient" as OodaPhase,
            content: `${HUMAN_REQUIRED_PREFIX}${question}`,
            timestamp: new Date().toISOString(),
          }];
          return { status: "waiting_human" as const, logs: escalationLogs, owner: undefined };
        } else {
          const retryCount = (current.context.retryCount as number) || 0;
          if (retryCount < MAX_TASK_RETRIES) {
            const newRetryCount = retryCount + 1;
            const retryAfter = new Date(Date.now() + RETRY_BASE_MS * Math.pow(2, retryCount)).toISOString();
            const retryLogs = [...logs, {
              phase: "act" as OodaPhase,
              content: `[RETRY] ${newRetryCount}/${MAX_TASK_RETRIES} - exit code ${exitCode}`,
              timestamp: new Date().toISOString(),
            }];
            return {
              status: "observing" as const,
              logs: retryLogs,
              owner: undefined,
              context: { ...current.context, retryCount: newRetryCount, retryAfter },
            };
          } else {
            const failLogs = [...logs, {
              phase: "act" as OodaPhase,
              content: `[FAILED] exit code ${exitCode}`,
              timestamp: new Date().toISOString(),
            }];
            return { status: "failed" as const, logs: failLogs, owner: undefined };
          }
        }
      }, storePath);

      if (exitCode === 0) {
        await runOnDoneHooks(task.id, task.title);
        const doneTask = (await load(storePath)).find(t => t.id === task.id);
        if (doneTask) {
          await ensureReportForDoneTask(doneTask, mission.name, { reportsPath });
        }
      }

      return { exitCode, output };
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  })();

  return { spawnId: spawnRecord.id, pid: proc.pid, completion };
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
      if (orientResult === "escalated") {
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
    if (useWorktree && !claimed.context.worktreeDisabled) {
      try {
        worktreeInfo = await createWorktree(task.id);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Worktree creation failed, falling back to main tree: ${msg}`);
      }
    }

    const prompt = buildActPrompt(claimed, mission);
    const command = [...(actCommand ?? ["claude", "-p", "--max-turns", "30"]), prompt];

    const spawnCwd = worktreeInfo?.worktreePath;
    await updateTask(task.id, (current) => ({
      status: "acting" as const,
      logs: [...current.logs, phaseLog("act", `Spawning: ${command[0]}${spawnCwd ? ` (worktree: ${worktreeInfo!.branchName})` : ""}`)],
    }), storePath);

    const taskEnv: Record<string, string> = {
      WORQLOAD_CLI: "worqload",
      WORQLOAD_TASK_ID: task.id,
      WORQLOAD_TASK_TITLE: task.title,
      WORQLOAD_TASK_CONTEXT: JSON.stringify(claimed.context),
    };
    if (mission.principles.length > 0) {
      taskEnv.WORQLOAD_MISSION_PRINCIPLES = mission.principles.join("\n");
    }

    let spawnResult: SpawnWithTimeoutResult;
    try {
      spawnResult = await spawnWithTimeout(command, { ...process.env, ...taskEnv }, spawnTimeoutMs, spawnCwd);
    } catch (error) {
      if (error instanceof SpawnTimeoutError) {
        const retryCount = (claimed.context.retryCount as number) || 0;
        if (retryCount < MAX_TASK_RETRIES) {
          const newRetryCount = retryCount + 1;
          const retryAfter = new Date(Date.now() + RETRY_BASE_MS * Math.pow(2, retryCount)).toISOString();
          await updateTask(task.id, (current) => ({
            status: "observing" as const,
            owner: undefined,
            context: { ...current.context, retryCount: newRetryCount, retryAfter },
            logs: [...current.logs, phaseLog("act", `[TIMEOUT] Spawn timed out after ${spawnTimeoutMs}ms`)],
          }), storePath);
          console.log(`Timeout retry ${newRetryCount}/${MAX_TASK_RETRIES}: ${task.title}`);
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
    const truncated = output.length > 2000 ? output.slice(-2000) : output;

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
      const retryCount = (claimed.context.retryCount as number) || 0;
      if (retryCount < MAX_TASK_RETRIES) {
        const newRetryCount = retryCount + 1;
        const retryAfter = new Date(Date.now() + RETRY_BASE_MS * Math.pow(2, retryCount)).toISOString();
        const disableWorktree = !!worktreeInfo;
        await updateTask(task.id, (current) => ({
          status: "observing" as const,
          owner: undefined,
          context: { ...current.context, retryCount: newRetryCount, retryAfter, ...(disableWorktree ? { worktreeDisabled: true } : {}) },
          logs: [...current.logs,
            phaseLog("act", truncated),
            phaseLog("act", `[RETRY] ${newRetryCount}/${MAX_TASK_RETRIES} - exit code ${exitCode}${disableWorktree ? " (worktree disabled for retry)" : ""}`),
          ],
        }), storePath);
        if (disableWorktree) {
          console.log(`Worktree disabled for retry: ${task.title}`);
        }
        console.log(`Retry ${newRetryCount}/${MAX_TASK_RETRIES}: ${task.title}`);
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
    const retryCount = (claimed.context.retryCount as number) || 0;
    if (retryCount < MAX_TASK_RETRIES) {
      const newRetryCount = retryCount + 1;
      const retryAfter = new Date(Date.now() + RETRY_BASE_MS * Math.pow(2, retryCount)).toISOString();
      await updateTask(task.id, (current) => ({
        status: "observing" as const,
        owner: undefined,
        context: { ...current.context, retryCount: newRetryCount, retryAfter },
        logs: [...current.logs, phaseLog("act", `[RETRY] ${newRetryCount}/${MAX_TASK_RETRIES} - ${message}`)],
      }), storePath);
      console.log(`Retry ${newRetryCount}/${MAX_TASK_RETRIES}: ${task.title}`);
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
      missionTasks.every(t => t.status === "done" || t.status === "failed");
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
      missionTasks.every(t => t.status === "done" || t.status === "failed");
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
  console.log(`Mission agent started: ${mission.name}`);
  if (mission.principles.length > 0) {
    console.log(`Principles: ${mission.principles.join("; ")}`);
  }

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

        if (useWorktree) {
          // Parallel: process all eligible tasks concurrently in worktrees
          const queue2 = new TaskQueue(storePath);
          await queue2.load();
          const eligible = findAllEligibleTasks(queue2, mission.id);
          if (eligible.length > 1) {
            const missionObj = await resolveMission(mission.id, missionsPath);
            const promises = eligible.map(t =>
              processTask(t, missionObj, { storePath, actCommand, missionsPath, spawnTimeoutMs, reportsPath, useWorktree: true })
                .catch(err => console.error(`Parallel task failed: ${t.title.slice(0, 40)} - ${err}`))
            );
            await Promise.all(promises);
            result = "processed";
          } else {
            result = await iterateMission(mission.id, { storePath, missionsPath, spawnCommand, spawnsPath, actCommand, spawnTimeoutMs, reportsPath, useWorktree });
          }
        } else {
          result = await iterateMission(mission.id, { storePath, missionsPath, spawnCommand, spawnsPath, actCommand, spawnTimeoutMs, reportsPath, useWorktree });
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
