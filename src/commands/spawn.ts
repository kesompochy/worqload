import { exitWithError } from "../utils/errors";
import type { TaskQueue } from "../queue";
import { loadSpawns, recordSpawnStart, recordSpawnFinish } from "../spawns";
import { loadConfig } from "../config";
import { updateTask } from "../store";
import { resolveTask } from "./resolve";
import { loadMissions } from "../mission";
import { runOnDoneHooks } from "../hooks";
import { createWorktree, removeWorktree, mergeWorktreeBranch } from "../worktree";
import { loadRunnerStates, isProcessAlive } from "../mission-runner-state";
import { spawnWithTimeout, SpawnTimeoutError, buildTaskEnv, truncateOutput, killProcessTree, DEFAULT_SPAWN_TIMEOUT_MS, buildSpawnOutcomeUpdate, buildSpawnTimeoutUpdate } from "../spawn-executor";
import { isTerminal } from "../task";

async function runHook(command: string, env: Record<string, string>): Promise<{ output: string; exitCode: number }> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { output: (stdout + stderr).trim(), exitCode };
}

function parseEnvOutput(output: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = line.match(/^(WORQLOAD_\w+)=(.*)$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

export async function spawn(queue: TaskQueue, args: string[], options?: { spawnTimeoutMs?: number }) {
  const task = resolveTask(queue, args[0]);
  const commandArgs = args.slice(1);
  if (commandArgs.length === 0) {
    console.error("Usage: worqload spawn <id> <command...>");
    exitWithError("Example: worqload spawn abc123 claude -p 'Process this task'");
  }

  if (isTerminal(task)) {
    console.log(`Spawn skip: task already ${task.status} (${task.title})`);
    return;
  }
  if (task.owner) {
    console.log(`Spawn skip: task already claimed by ${task.owner} (${task.title})`);
    return;
  }
  if (task.status !== "observing") {
    console.log(`Spawn skip: task is ${task.status}, not observing (${task.title})`);
    return;
  }

  const owner = commandArgs.join(" ").slice(0, 50);
  queue.claim(task.id, owner);
  await queue.save();

  const config = await loadConfig();
  let missionPrinciples: string[] | undefined;
  if (task.missionId) {
    const missions = await loadMissions();
    const m = missions.find(mi => mi.id === task.missionId);
    if (m && m.principles && m.principles.length > 0) {
      missionPrinciples = m.principles;
    }
  }
  const taskEnv = buildTaskEnv({
    taskId: task.id,
    taskTitle: task.title,
    taskContext: task.context,
    missionPrinciples,
  });

  let spawnCwd: string | undefined;
  if (config.spawn?.pre) {
    for (const hook of config.spawn.pre) {
      console.log(`Running pre-spawn hook: ${hook}`);
      const result = await runHook(hook, taskEnv);
      if (result.exitCode !== 0) {
        console.error(`Pre-spawn hook failed (exit ${result.exitCode}): ${result.output}`);
        queue.addLog(task.id, "act", `[FAILED] pre-spawn hook: ${result.output}`);
        queue.transition(task.id, "failed");
        queue.update(task.id, { owner: undefined });
        await queue.save();
        return;
      }
      const hookVars = parseEnvOutput(result.output);
      if (hookVars.WORQLOAD_SPAWN_CWD) {
        spawnCwd = hookVars.WORQLOAD_SPAWN_CWD;
      }
      Object.assign(taskEnv, hookVars);
    }
  }

  let worktreeInfo: { worktreePath: string; branchName: string } | undefined;
  if (config.spawn?.worktree && !spawnCwd) {
    try {
      worktreeInfo = await createWorktree(task.id);
      spawnCwd = worktreeInfo.worktreePath;
      console.log(`Worktree created: ${spawnCwd}`);
    } catch (err) {
      console.error(`Worktree creation failed, spawning in main directory: ${err}`);
    }
  }

  console.log(`Spawning: ${task.title} (${owner}${spawnCwd ? `, cwd: ${spawnCwd}` : ''})`);

  const timeoutMs = options?.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  let timedOut = false;
  let exitCode = -1;
  let spawnRecordId: string | undefined;

  try {
    let spawnResult;
    try {
      spawnResult = await spawnWithTimeout(commandArgs, { ...process.env, ...taskEnv }, timeoutMs, spawnCwd, {
        onStart: async (pid) => {
          const record = await recordSpawnStart(
            task.id, task.title, owner, pid, undefined,
            worktreeInfo ? { worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName } : undefined,
          );
          spawnRecordId = record.id;
        },
      });
    } catch (error) {
      if (error instanceof SpawnTimeoutError) {
        timedOut = true;
        if (spawnRecordId) await recordSpawnFinish(spawnRecordId, -1);
        await updateTask(task.id, (current) => buildSpawnTimeoutUpdate(timeoutMs, current), queue.getStorePath());
        console.error(`Timeout: ${task.title}`);
        return;
      }
      throw error;
    }

    exitCode = spawnResult.exitCode;
    if (spawnRecordId) await recordSpawnFinish(spawnRecordId, exitCode);

    const postEnv: Record<string, string> = {
      ...taskEnv,
      WORQLOAD_SPAWN_EXIT_CODE: String(exitCode),
      ...(spawnCwd ? { WORQLOAD_SPAWN_CWD: spawnCwd } : {}),
    };

    if (config.spawn?.post) {
      for (const hook of config.spawn.post) {
        console.log(`Running post-spawn hook: ${hook}`);
        const result = await runHook(hook, postEnv);
        if (result.exitCode !== 0) {
          console.error(`Post-spawn hook failed (exit ${result.exitCode}): ${result.output}`);
        }
        if (result.output) {
          queue.addLog(task.id, "act", `[post-spawn] ${result.output}`);
        }
      }
    }

    const output = (spawnResult.stdout + spawnResult.stderr).trim();
    const truncated = truncateOutput(output);

    const updated = await updateTask(task.id, (current) => {
      const update = buildSpawnOutcomeUpdate(exitCode, truncated, current);
      if (!update.status) console.log(`Already ${current.status}: ${task.title}`);
      else if (update.status === "done") console.log(`Done: ${task.title}`);
      else if (update.status === "waiting_human") console.log(`Escalated: ${task.title}`);
      else if (update.status === "failed") console.log(`Failed: ${task.title} (exit: ${exitCode})`);
      return update;
    }, queue.getStorePath());

    if (updated?.status === "done") {
      await runOnDoneHooks(task.id, task.title);
    }
  } finally {
    if (worktreeInfo) {
      try {
        if (!timedOut && exitCode === 0) {
          const merged = await mergeWorktreeBranch(worktreeInfo.branchName);
          if (!merged) {
            console.error(`Worktree merge conflict: branch ${worktreeInfo.branchName} retained for manual merge`);
          }
        }
        await removeWorktree(worktreeInfo.worktreePath, worktreeInfo.branchName);
      } catch (err) {
        console.error(`Worktree cleanup failed: ${err}`);
      }
    }
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const IN_PROGRESS_STATUSES = new Set(["observing", "orienting", "deciding", "acting"]);
const SPAWN_CLEANUP_TIMEOUT_MS = 30 * 60 * 1000;

export async function spawnCleanup(queue: TaskQueue, args: string[], spawnsPath?: string, repoDir?: string, runnerStatePath?: string): Promise<void> {
  const spawns = await loadSpawns(spawnsPath);
  const runners = await loadRunnerStates(runnerStatePath);
  const stuckTasks = queue.list().filter(
    t => IN_PROGRESS_STATUSES.has(t.status) && t.owner,
  );

  let cleaned = 0;
  for (const task of stuckTasks) {
    const spawnRecord = spawns.find(s => s.taskId === task.id && s.status === "running");

    if (spawnRecord && isProcessRunning(spawnRecord.pid)) {
      const elapsed = Date.now() - new Date(spawnRecord.startedAt).getTime();
      if (elapsed < SPAWN_CLEANUP_TIMEOUT_MS) {
        continue;
      }
      killProcessTree(spawnRecord.pid);
    }

    // Mission-owned tasks without spawn records: check if the runner daemon is alive
    if (!spawnRecord && task.owner?.startsWith("mission:")) {
      const missionName = task.owner.slice("mission:".length);
      const aliveRunner = runners.find(r =>
        r.missionName === missionName && r.status !== "stopped" && isProcessAlive(r.pid),
      );
      if (aliveRunner) continue;
    }

    queue.addLog(task.id, "act", "[FAILED] Spawn process killed (timeout)");
    queue.transition(task.id, "failed");
    queue.update(task.id, { owner: undefined });

    if (spawnRecord) {
      await recordSpawnFinish(spawnRecord.id, -1, spawnsPath);

      if (spawnRecord.worktreePath && spawnRecord.branchName) {
        try {
          await removeWorktree(spawnRecord.worktreePath, spawnRecord.branchName, repoDir);
          console.log(`Worktree cleaned: ${spawnRecord.branchName}`);
        } catch (err) {
          console.error(`Worktree cleanup failed: ${err}`);
        }
      }
    }

    cleaned++;
    console.log(`Cleaned: ${task.title} (was ${task.status}, owner: ${task.owner})`);
  }

  if (cleaned > 0) {
    await queue.save();
  }
  console.log(`Cleaned ${cleaned} stuck task(s)`);
}
