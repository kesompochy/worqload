import type { TaskQueue } from "../queue";
import { recordSpawnStart, recordSpawnFinish } from "../spawns";
import { loadConfig } from "../config";
import { resolveTask } from "./resolve";

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
    console.error("Example: worqload spawn abc123 claude -p 'Process this task'");
    process.exit(1);
  }

  const owner = commandArgs.join(" ").slice(0, 50);
  queue.claim(task.id, owner);
  queue.transition(task.id, "observing");
  await queue.save();

  const config = await loadConfig();
  const taskEnv: Record<string, string> = {
    WORQLOAD_TASK_ID: task.id,
    WORQLOAD_TASK_TITLE: task.title,
    WORQLOAD_TASK_CONTEXT: JSON.stringify(task.context),
  };

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

  await queue.load();
  const current = queue.get(task.id);
  const output = (stdout + stderr).trim();
  const truncated = output.length > 2000 ? output.slice(-2000) : output;
  queue.addLog(task.id, "act", truncated);

  const alreadyTerminal = current && (current.status === "done" || current.status === "failed");
  if (alreadyTerminal) {
    console.log(`Already ${current.status}: ${task.title}`);
  } else if (exitCode === 0) {
    queue.transition(task.id, "done");
    console.log(`Done: ${task.title}`);
  } else {
    queue.addLog(task.id, "act", `[FAILED] exit code ${exitCode}`);
    queue.transition(task.id, "failed");
    console.log(`Failed: ${task.title} (exit: ${exitCode})`);
  }

  queue.update(task.id, { owner: undefined });
  await queue.save();
}
