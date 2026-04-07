import type { Task } from "./task";
import type { Mission } from "./mission";
import { updateTask, load } from "./store";
import { runOnDoneHooks } from "./hooks";
import { recordSpawnStart, recordSpawnFinish } from "./spawns";
import { spawnWithTimeout, SpawnTimeoutError, DEFAULT_SPAWN_TIMEOUT_MS, buildTaskEnv, truncateOutput, buildSpawnOutcomeUpdate, buildSpawnTimeoutUpdate } from "./spawn-executor";
import type { RetryPolicy } from "./spawn-executor";
import { canRetry, computeRetryUpdate, MAX_TASK_RETRIES } from "./mission-runner-retry";
import { ensureReportForDoneTask, isReportToHumanTask } from "./mission-runner-act";

export interface SpawnCompletion {
  exitCode: number;
  output: string;
}

export interface SpawnResult {
  spawnId: string;
  pid: number;
  completion: Promise<SpawnCompletion>;
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

  const taskEnv = buildTaskEnv({
    taskId: task.id,
    taskTitle: task.title,
    taskContext: task.context,
    missionPrinciples: mission.principles,
  });

  let resolveStarted!: (v: { spawnId: string; pid: number }) => void;
  let rejectStarted!: (e: Error) => void;
  const startedPromise = new Promise<{ spawnId: string; pid: number }>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });

  const retryPolicy: RetryPolicy = {
    canRetry,
    computeRetry: computeRetryUpdate,
    maxRetries: MAX_TASK_RETRIES,
  };
  const skipRetry = isReportToHumanTask(task);

  const completion = (async (): Promise<SpawnCompletion> => {
    let spawnRecordId: string | undefined;
    try {
      const result = await spawnWithTimeout(command, { ...process.env, ...taskEnv }, spawnTimeoutMs, undefined, {
        onStart: async (pid) => {
          const record = await recordSpawnStart(task.id, task.title, owner, pid, spawnsPath);
          spawnRecordId = record.id;
          resolveStarted({ spawnId: record.id, pid });
        },
      });

      if (spawnRecordId) await recordSpawnFinish(spawnRecordId, result.exitCode, spawnsPath);

      const output = (result.stdout + result.stderr).trim();
      const truncated = truncateOutput(output);

      await updateTask(task.id, (current) =>
        buildSpawnOutcomeUpdate(result.exitCode, truncated, current, { retryPolicy, skipRetry }),
      storePath);

      if (result.exitCode === 0) {
        await runOnDoneHooks(task.id, task.title);
        const doneTask = (await load(storePath)).find(t => t.id === task.id);
        if (doneTask) {
          await ensureReportForDoneTask(doneTask, mission.name, { reportsPath });
        }
      }

      return { exitCode: result.exitCode, output };
    } catch (error) {
      if (error instanceof SpawnTimeoutError) {
        if (spawnRecordId) await recordSpawnFinish(spawnRecordId, -1, spawnsPath);
        await updateTask(task.id, (current) =>
          buildSpawnTimeoutUpdate(spawnTimeoutMs, current, { retryPolicy, skipRetry }),
        storePath);
        return { exitCode: -1, output: "" };
      }
      rejectStarted(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  })();

  const { spawnId, pid } = await startedPromise;
  return { spawnId, pid, completion };
}
