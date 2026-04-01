import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { TaskQueue } from "../queue";
import { createTask, ESCALATION_EXIT_CODE, HUMAN_REQUIRED_PREFIX } from "../task";
import { spawn, spawnCleanup } from "./spawn";
import { recordSpawnStart } from "../spawns";
import { load } from "../store";
import { createWorktree } from "../worktree";

test("spawn skips task that is already done", async () => {
  const queue = new TaskQueue();
  const task = createTask("already done task");
  queue.enqueue(task);
  queue.transition(task.id, "done");

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await spawn(queue, [task.id, "echo", "hello"]);
  } finally {
    console.log = origLog;
  }

  expect(logs.some(l => l.includes("skip"))).toBe(true);
  const updated = queue.get(task.id);
  expect(updated?.status).toBe("done");
});

test("spawn skips task that is already failed", async () => {
  const queue = new TaskQueue();
  const task = createTask("already failed task");
  queue.enqueue(task);
  queue.transition(task.id, "failed");

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await spawn(queue, [task.id, "echo", "hello"]);
  } finally {
    console.log = origLog;
  }

  expect(logs.some(l => l.includes("skip"))).toBe(true);
  const updated = queue.get(task.id);
  expect(updated?.status).toBe("failed");
});

test("spawn skips task that already has an owner", async () => {
  const queue = new TaskQueue();
  const task = createTask("claimed task");
  queue.enqueue(task);
  queue.claim(task.id, "other-agent");

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await spawn(queue, [task.id, "echo", "hello"]);
  } finally {
    console.log = origLog;
  }

  expect(logs.some(l => l.includes("skip"))).toBe(true);
  const updated = queue.get(task.id);
  expect(updated?.owner).toBe("other-agent");
});

test("spawn skips task that is not in observing status", async () => {
  const queue = new TaskQueue();
  const task = createTask("orienting task");
  queue.enqueue(task);
  queue.transition(task.id, "orienting");

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await spawn(queue, [task.id, "echo", "hello"]);
  } finally {
    console.log = origLog;
  }

  expect(logs.some(l => l.includes("skip"))).toBe(true);
  const updated = queue.get(task.id);
  expect(updated?.status).toBe("orienting");
});

function tmpPath(label: string): string {
  return join(tmpdir(), `worqload-spawn-cmd-${label}-${crypto.randomUUID()}.json`);
}

describe("spawn WORQLOAD_CLI environment variable", () => {
  test("sets WORQLOAD_CLI to an absolute path", async () => {
    const storePath = tmpPath("spawn-cli-path");
    const queue = new TaskQueue(storePath);
    const task = createTask("cli path task");
    queue.enqueue(task);
    await queue.save();

    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await spawn(queue, [task.id, "sh", "-c", "echo $WORQLOAD_CLI"]);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    const actLog = updated?.logs.find(l => l.phase === "act");
    expect(actLog).toBeDefined();
    // The output should contain an absolute path (starts with /)
    expect(actLog!.content).toMatch(/^\//);
    // Should not be just the bare command name "worqload"
    expect(actLog!.content.trim()).not.toBe("worqload");
  });
});

describe("spawn escalation via exit code", () => {
  test("transitions to waiting_human on exit code 3", async () => {
    const storePath = tmpPath("spawn-escalate");
    const queue = new TaskQueue(storePath);
    const task = createTask("escalation task");
    queue.enqueue(task);
    await queue.save();

    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await spawn(queue, [task.id, "sh", "-c", `echo "Need human help"; exit ${ESCALATION_EXIT_CODE}`]);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("waiting_human");
    expect(updated?.owner).toBeUndefined();
    const orientLog = updated?.logs.find(l => l.phase === "orient" && l.content.includes(HUMAN_REQUIRED_PREFIX));
    expect(orientLog).toBeDefined();
    expect(logs.some(l => l.includes("Escalated"))).toBe(true);
  });
});

describe("spawn timeout", () => {
  test("spawn kills process and marks task failed on timeout", async () => {
    const storePath = tmpPath("spawn-timeout");
    const queue = new TaskQueue(storePath);
    const task = createTask("slow cli task");
    queue.enqueue(task);
    await queue.save();

    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await spawn(queue, [task.id, "sleep", "30"], { spawnTimeoutMs: 200 });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.owner).toBeUndefined();
    const timeoutLog = updated?.logs.find(l => l.content.includes("[TIMEOUT]"));
    expect(timeoutLog).toBeDefined();
  });

  test("spawn completes normally when within timeout", async () => {
    const storePath = tmpPath("spawn-timeout-ok");
    const queue = new TaskQueue(storePath);
    const task = createTask("fast cli task");
    queue.enqueue(task);
    await queue.save();

    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await spawn(queue, [task.id, "echo", "quick"], { spawnTimeoutMs: 5000 });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    const tasks = await load(storePath);
    const updated = tasks.find(t => t.id === task.id);
    expect(updated?.status).toBe("done");
  });
});

describe("spawnCleanup", () => {
  test("cleans up task in orienting status with dead owner process", async () => {
    const queue = new TaskQueue(tmpPath("cleanup-orienting"));
    const task = createTask("Stuck orienting task");
    queue.enqueue(task);
    queue.claim(task.id, "claude -p");
    queue.transition(task.id, "orienting");
    await queue.save();

    const spawnsPath = tmpPath("spawns-orienting");
    // Record a spawn with a non-existent PID
    await recordSpawnStart(task.id, task.title, "claude -p", 999999, spawnsPath);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await spawnCleanup(queue, [], spawnsPath);
    } finally {
      console.log = origLog;
    }

    const updated = queue.get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.owner).toBeUndefined();
    expect(logs.some(l => l.includes("Cleaned") && l.includes("orienting"))).toBe(true);
  });

  test("cleans up task in deciding status with dead owner process", async () => {
    const queue = new TaskQueue(tmpPath("cleanup-deciding"));
    const task = createTask("Stuck deciding task");
    queue.enqueue(task);
    queue.claim(task.id, "claude -p");
    queue.transition(task.id, "orienting");
    queue.transition(task.id, "deciding");
    await queue.save();

    const spawnsPath = tmpPath("spawns-deciding");
    await recordSpawnStart(task.id, task.title, "claude -p", 999999, spawnsPath);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await spawnCleanup(queue, [], spawnsPath);
    } finally {
      console.log = origLog;
    }

    const updated = queue.get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.owner).toBeUndefined();
  });

  test("kills long-running live process and cleans up task", async () => {
    // Spawn a real long-running process
    const sleepProc = Bun.spawn(["sleep", "300"], { stdout: "pipe", stderr: "pipe" });
    const pid = sleepProc.pid;

    try {
      const queue = new TaskQueue(tmpPath("cleanup-kill"));
      const task = createTask("Stuck with live process");
      queue.enqueue(task);
      queue.claim(task.id, "claude -p");
      queue.transition(task.id, "orienting");
      queue.transition(task.id, "deciding");
      queue.transition(task.id, "acting");
      await queue.save();

      const spawnsPath = tmpPath("spawns-kill");
      const spawnRecord = await recordSpawnStart(task.id, task.title, "claude -p", pid, spawnsPath);
      // Backdate the spawn record so it appears long-running
      const { loadSpawns, saveSpawns } = await import("../spawns");
      const spawns = await loadSpawns(spawnsPath);
      const record = spawns.find(s => s.id === spawnRecord.id);
      if (record) {
        record.startedAt = new Date(Date.now() - 35 * 60 * 1000).toISOString();
        await saveSpawns(spawns, spawnsPath);
      }

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));
      try {
        await spawnCleanup(queue, [], spawnsPath);
      } finally {
        console.log = origLog;
      }

      const updated = queue.get(task.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.owner).toBeUndefined();

      // Verify process was killed
      let running = true;
      try { process.kill(pid, 0); } catch { running = false; }
      expect(running).toBe(false);
    } finally {
      try { process.kill(sleepProc.pid, "SIGKILL"); } catch {}
    }
  });

  test("skips live processes that are not yet past timeout", async () => {
    // Spawn a real process
    const sleepProc = Bun.spawn(["sleep", "300"], { stdout: "pipe", stderr: "pipe" });
    const pid = sleepProc.pid;

    try {
      const queue = new TaskQueue(tmpPath("cleanup-recent"));
      const task = createTask("Recently started task");
      queue.enqueue(task);
      queue.claim(task.id, "claude -p");
      queue.transition(task.id, "orienting");
      queue.transition(task.id, "deciding");
      queue.transition(task.id, "acting");
      await queue.save();

      const spawnsPath = tmpPath("spawns-recent");
      // Spawn record with recent startedAt (default is now)
      await recordSpawnStart(task.id, task.title, "claude -p", pid, spawnsPath);

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));
      try {
        await spawnCleanup(queue, [], spawnsPath);
      } finally {
        console.log = origLog;
      }

      // Task should NOT be cleaned up
      const updated = queue.get(task.id);
      expect(updated?.status).toBe("acting");
      expect(updated?.owner).toBe("claude -p");
    } finally {
      try { process.kill(sleepProc.pid, "SIGKILL"); } catch {}
    }
  });

  test("cleans up orphaned worktree directory and branch", async () => {
    const cleanGitEnv = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };
    function git(args: string[], cwd: string) {
      return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: cleanGitEnv });
    }

    // Create a temp git repo with a worktree
    const repoDir = join(tmpdir(), `worqload-cleanup-wt-${crypto.randomUUID()}`);
    mkdirSync(repoDir, { recursive: true });
    git(["init"], repoDir);
    git(["config", "user.email", "test@test.com"], repoDir);
    git(["config", "user.name", "Test"], repoDir);
    writeFileSync(join(repoDir, "README.md"), "# test\n");
    mkdirSync(join(repoDir, ".worqload"), { recursive: true });
    writeFileSync(join(repoDir, ".worqload", "tasks.json"), "[]");
    git(["add", "."], repoDir);
    git(["commit", "-m", "initial"], repoDir);

    const taskId = crypto.randomUUID();
    const { worktreePath, branchName } = await createWorktree(taskId, repoDir);
    expect(existsSync(worktreePath)).toBe(true);

    // Create a stuck task with worktree info in spawn record
    const queue = new TaskQueue(tmpPath("cleanup-worktree"));
    const task = createTask("Stuck worktree task");
    (task as any).id = taskId;
    queue.enqueue(task);
    queue.claim(task.id, "claude -p");
    queue.transition(task.id, "orienting");
    await queue.save();

    const spawnsPath = tmpPath("spawns-worktree");
    await recordSpawnStart(task.id, task.title, "claude -p", 999999, spawnsPath, {
      worktreePath,
      branchName,
    });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await spawnCleanup(queue, [], spawnsPath, repoDir);
    } finally {
      console.log = origLog;
    }

    const updated = queue.get(task.id);
    expect(updated?.status).toBe("failed");

    // Worktree directory should be removed
    expect(existsSync(worktreePath)).toBe(false);

    // Branch should be deleted
    const branchResult = git(["branch", "--list", branchName], repoDir);
    const branchOutput = new TextDecoder().decode(branchResult.stdout).trim();
    expect(branchOutput).toBe("");

    // Cleanup
    try {
      const { rmSync } = await import("fs");
      rmSync(repoDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });
});
