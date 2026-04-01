import { join, resolve } from "path";
import { existsSync, symlinkSync, unlinkSync } from "fs";
import { mkdir, rmdir } from "node:fs/promises";

function cleanGitEnv(): Record<string, string | undefined> {
  return { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };
}

const MERGE_LOCK_TIMEOUT_MS = 120_000;
const MERGE_LOCK_RETRY_MS = 100;

async function withMergeLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(resolve(repoDir), ".git", "worqload-merge.lock");
  const deadline = Date.now() + MERGE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Merge lock timeout: ${lockPath} (${MERGE_LOCK_TIMEOUT_MS}ms)`);
      }
      await new Promise(r => setTimeout(r, MERGE_LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    try { await rmdir(lockPath); } catch { /* already gone */ }
  }
}

export async function createWorktree(
  taskId: string,
  repoDir: string = process.cwd(),
): Promise<{ worktreePath: string; branchName: string }> {
  const shortId = taskId.slice(0, 8);
  const branchName = `worqload/${shortId}`;
  const worktreePath = join(resolve(repoDir), ".worktrees", shortId);

  const proc = Bun.spawn(
    ["git", "worktree", "add", "-b", branchName, worktreePath, "HEAD"],
    { stdout: "pipe", stderr: "pipe", cwd: repoDir, env: cleanGitEnv() },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to create worktree: ${stderr.trim()}`);
  }

  const sourceWorqload = resolve(repoDir, ".worqload");
  const targetWorqload = join(worktreePath, ".worqload");
  if (existsSync(sourceWorqload) && !existsSync(targetWorqload)) {
    symlinkSync(sourceWorqload, targetWorqload);
  }

  return { worktreePath, branchName };
}

export async function mergeWorktreeBranch(
  branchName: string,
  repoDir: string = process.cwd(),
): Promise<boolean> {
  return withMergeLock(repoDir, async () => {
    const env = cleanGitEnv();

    const logProc = Bun.spawn(
      ["git", "log", `HEAD..${branchName}`, "--oneline"],
      { stdout: "pipe", stderr: "pipe", cwd: repoDir, env },
    );
    const logOutput = await new Response(logProc.stdout).text();
    await logProc.exited;

    if (!logOutput.trim()) {
      return true;
    }

    const mergeProc = Bun.spawn(
      ["git", "merge", branchName, "--no-edit"],
      { stdout: "pipe", stderr: "pipe", cwd: repoDir, env },
    );
    const mergeExit = await mergeProc.exited;

    if (mergeExit !== 0) {
      Bun.spawnSync(["git", "merge", "--abort"], { cwd: repoDir, stdout: "pipe", stderr: "pipe", env });
      return false;
    }

    return true;
  });
}

export async function removeWorktree(
  worktreePath: string,
  branchName?: string,
  repoDir?: string,
): Promise<void> {
  const env = cleanGitEnv();

  const symlinkPath = join(worktreePath, ".worqload");
  try { unlinkSync(symlinkPath); } catch { /* already gone */ }

  const removeProc = Bun.spawn(
    ["git", "worktree", "remove", "--force", worktreePath],
    { stdout: "pipe", stderr: "pipe", env, ...(repoDir ? { cwd: repoDir } : {}) },
  );
  await removeProc.exited;

  if (branchName) {
    const branchProc = Bun.spawn(
      ["git", "branch", "-D", branchName],
      { stdout: "pipe", stderr: "pipe", env, ...(repoDir ? { cwd: repoDir } : {}) },
    );
    await branchProc.exited;
  }
}
