import type { TaskQueue } from "../queue";
import { recordSpawnStart, recordSpawnFinish } from "../spawns";
import { createWorktree, removeWorktree, mergeWorktreeBranch } from "../worktree";
import { resolveTask } from "./resolve";

export async function spawn(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  const owner = args[1] || `spawn-${process.pid}`;
  queue.claim(task.id, owner);
  queue.transition(task.id, "observing");
  await queue.save();

  const taskIdPrefix = task.id.slice(0, 8);
  let worktree: { path: string; branch: string } | undefined;
  try {
    worktree = await createWorktree(taskIdPrefix);
    console.log(`Spawning: ${task.title} (owner: ${owner}, worktree: ${worktree.path})`);
  } catch (error) {
    console.error(`Failed to create worktree, running in main directory: ${error}`);
    console.log(`Spawning: ${task.title} (owner: ${owner})`);
  }

  const cwd = worktree ? worktree.path : undefined;
  const prompt = [
    `You are processing a worqload task. Work in the current directory.`,
    `Task: ${task.title}`,
    `Task ID: ${taskIdPrefix}`,
    ``,
    `Instructions:`,
    `1. Understand the task`,
    `2. Make the necessary code changes`,
    `3. Run tests with: bun test`,
    `4. Commit your changes with a descriptive message`,
    `5. Report what you did`,
    ``,
    `Context: ${JSON.stringify(task.context)}`,
  ].join("\n");

  const proc = Bun.spawn(["claude", "-p", "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep", "--", prompt], {
    stdout: "pipe",
    stderr: "pipe",
    ...(cwd ? { cwd } : {}),
  });
  const spawnRecord = await recordSpawnStart(task.id, task.title, owner, proc.pid);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  await recordSpawnFinish(spawnRecord.id, exitCode, undefined, worktree?.path, worktree?.branch);

  await queue.load();
  const current = queue.get(task.id);
  const output = (stdout + stderr).trim();
  const truncated = output.length > 2000 ? output.slice(-2000) : output;
  queue.addLog(task.id, "act", truncated);

  const alreadyTerminal = current && (current.status === "done" || current.status === "failed");
  if (alreadyTerminal) {
    console.log(`Already ${current.status}: ${task.title}`);
  } else if (exitCode === 0) {
    if (worktree) {
      const mergeResult = await mergeWorktreeBranch(worktree.branch);
      if (mergeResult.merged) {
        queue.addLog(task.id, "act", `[MERGED] branch ${worktree.branch}`);
        console.log(`Merged: ${worktree.branch}`);
      } else {
        queue.addLog(task.id, "act", `[MERGE CONFLICT] branch ${worktree.branch}: ${mergeResult.output}`);
        console.log(`Merge conflict on ${worktree.branch} — resolve manually`);
      }
    }
    queue.transition(task.id, "done");
    console.log(`Done: ${task.title}`);
  } else {
    queue.addLog(task.id, "act", `[FAILED] exit code ${exitCode}`);
    queue.transition(task.id, "failed");
    console.log(`Failed: ${task.title} (exit: ${exitCode})`);
  }

  if (worktree) {
    await removeWorktree(worktree.path, worktree.branch);
  }
  queue.update(task.id, { owner: undefined });
  await queue.save();
}
