import { exitWithError } from "../utils/errors";
import type { TaskQueue } from "../queue";
import { loadSpawns, recordSpawnStart, recordSpawnFinish } from "../spawns";
import { loadConfig } from "../config";
import { updateTask } from "../store";
import type { Task, OodaPhase } from "../task";
import { validateTransition } from "../task";
import { resolveTask } from "./resolve";
import { loadMissions } from "../mission";
import { runOnDoneHooks } from "../hooks";

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

export async function spawn(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  const commandArgs = args.slice(1);
  if (commandArgs.length === 0) {
    console.error("Usage: worqload spawn <id> <command...>");
    exitWithError("Example: worqload spawn abc123 claude -p 'Process this task'");
  }

  const owner = commandArgs.join(" ").slice(0, 50);
  queue.claim(task.id, owner);
  await queue.save();

  const config = await loadConfig();
  const taskEnv: Record<string, string> = {
    WORQLOAD_TASK_ID: task.id,
    WORQLOAD_TASK_TITLE: task.title,
    WORQLOAD_TASK_CONTEXT: JSON.stringify(task.context),
  };

  if (task.missionId) {
    const missions = await loadMissions();
    const m = missions.find(mi => mi.id === task.missionId);
    if (m && m.principles && m.principles.length > 0) {
      taskEnv.WORQLOAD_MISSION_PRINCIPLES = m.principles.join("\n");
    }
  }

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

  console.log(`Spawning: ${task.title} (${owner}${spawnCwd ? `, cwd: ${spawnCwd}` : ''})`);

  const proc = Bun.spawn(commandArgs, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...taskEnv },
    ...(spawnCwd ? { cwd: spawnCwd } : {}),
  });
  const spawnRecord = await recordSpawnStart(task.id, task.title, owner, proc.pid);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  await recordSpawnFinish(spawnRecord.id, exitCode);

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

  const output = (stdout + stderr).trim();
  const truncated = output.length > 2000 ? output.slice(-2000) : output;

  // Atomically update only this task in tasks.json to avoid overwriting other changes
  const updated = await updateTask(task.id, (current) => {
    const logs = [...current.logs, { phase: "act" as OodaPhase, content: truncated, timestamp: new Date().toISOString() }];
    const alreadyTerminal = current.status === "done" || current.status === "failed";
    if (alreadyTerminal) {
      console.log(`Already ${current.status}: ${task.title}`);
      return { logs, owner: undefined };
    } else if (exitCode === 0) {
      console.log(`Done: ${task.title}`);
      return { status: "done" as const, logs, owner: undefined };
    } else {
      console.log(`Failed: ${task.title} (exit: ${exitCode})`);
      const failLogs = [...logs, { phase: "act" as OodaPhase, content: `[FAILED] exit code ${exitCode}`, timestamp: new Date().toISOString() }];
      return { status: "failed" as const, logs: failLogs, owner: undefined };
    }
  });

  if (updated?.status === "done") {
    await autoCommit(task.title, spawnCwd);
    await runOnDoneHooks(task.id, task.title);
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

export async function spawnCleanup(queue: TaskQueue, args: string[], spawnsPath?: string): Promise<void> {
  const spawns = await loadSpawns(spawnsPath);
  const stuckTasks = queue.list().filter(
    t => (t.status === "observing" || t.status === "acting") && t.owner
  );

  let cleaned = 0;
  for (const task of stuckTasks) {
    const spawnRecord = spawns.find(s => s.taskId === task.id && s.status === "running");

    if (spawnRecord && isProcessRunning(spawnRecord.pid)) {
      continue;
    }

    queue.addLog(task.id, "act", "[FAILED] Spawn process killed (timeout)");
    queue.transition(task.id, "failed");
    queue.update(task.id, { owner: undefined });

    if (spawnRecord) {
      await recordSpawnFinish(spawnRecord.id, -1, spawnsPath);
    }

    cleaned++;
    console.log(`Cleaned: ${task.title} (was ${task.status}, owner: ${task.owner})`);
  }

  if (cleaned > 0) {
    await queue.save();
  }
  console.log(`Cleaned ${cleaned} stuck task(s)`);
}
