import { join, resolve } from "path";
import { existsSync, symlinkSync, unlinkSync } from "fs";
import { mkdir } from "node:fs/promises";

function cleanGitEnv(): Record<string, string | undefined> {
  return { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };
}

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
}

export async function createSessionWorktree(params: {
  sessionId: string;
  repoDir: string;
  baseBranch: string;
  reportsDirAbsolute: string;
}): Promise<WorktreeInfo> {
  const { sessionId, repoDir, baseBranch, reportsDirAbsolute } = params;
  const shortId = sessionId.slice(0, 8);
  const branchName = `worqload/${shortId}`;
  const worktreePath = join(resolve(repoDir), ".worktrees", shortId);

  await mkdir(reportsDirAbsolute, { recursive: true });

  const proc = Bun.spawn(
    ["git", "worktree", "add", "-b", branchName, worktreePath, baseBranch],
    { stdout: "pipe", stderr: "pipe", cwd: repoDir, env: cleanGitEnv() },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to create worktree: ${stderr.trim()}`);
  }

  // symlink so the agent can read its own reports via .worqload-reports/<file>
  const symlinkPath = join(worktreePath, ".worqload-reports");
  if (!existsSync(symlinkPath)) {
    symlinkSync(reportsDirAbsolute, symlinkPath);
  }

  return { worktreePath, branchName };
}

export async function removeWorktree(
  worktreePath: string,
  branchName?: string,
  repoDir?: string,
): Promise<void> {
  const env = cleanGitEnv();

  const symlinkPath = join(worktreePath, ".worqload-reports");
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

export async function resolveBaseCommit(
  baseBranch: string,
  repoDir: string,
): Promise<string> {
  const proc = Bun.spawn(
    ["git", "rev-parse", baseBranch],
    { stdout: "pipe", stderr: "pipe", cwd: repoDir, env: cleanGitEnv() },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`Failed to resolve ${baseBranch}: ${err.trim()}`);
  }
  return out.trim();
}

export async function currentBranch(repoDir: string): Promise<string> {
  const proc = Bun.spawn(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    { stdout: "pipe", stderr: "pipe", cwd: repoDir, env: cleanGitEnv() },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error("Failed to detect current branch");
  }
  return out.trim();
}

export async function gitDiff(worktreePath: string, target: string): Promise<string> {
  const proc = Bun.spawn(
    ["git", "diff", "--no-color", target],
    { stdout: "pipe", stderr: "pipe", cwd: worktreePath, env: cleanGitEnv() },
  );
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git diff ${target} failed: ${err.trim()}`);
  }
  return out;
}
