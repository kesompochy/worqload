import type { TaskQueue } from "../queue";
import { recordSpawnStart, recordSpawnFinish } from "../spawns";
import { resolveTask } from "./resolve";

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

  console.log(`Spawning: ${task.title} (${owner})`);

  const proc = Bun.spawn(commandArgs, {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      WORQLOAD_TASK_ID: task.id,
      WORQLOAD_TASK_TITLE: task.title,
      WORQLOAD_TASK_CONTEXT: JSON.stringify(task.context),
    },
  });
  const spawnRecord = await recordSpawnStart(task.id, task.title, owner, proc.pid);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  await recordSpawnFinish(spawnRecord.id, exitCode);

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
