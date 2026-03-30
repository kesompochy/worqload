import { $ } from "bun";

const WORKTREE_DIR = ".worqload/worktrees";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export async function createWorktree(taskIdPrefix: string): Promise<WorktreeInfo> {
  const branch = `worqload/${taskIdPrefix}`;
  const worktreePath = `${WORKTREE_DIR}/${taskIdPrefix}`;

  await $`git worktree add -b ${branch} ${worktreePath}`.quiet();
  return { path: worktreePath, branch };
}

export async function removeWorktree(worktreePath: string, branch: string): Promise<void> {
  try {
    await $`git worktree remove ${worktreePath} --force`.quiet();
  } catch {
    // worktree may already be removed
  }
  try {
    await $`git branch -D ${branch}`.quiet();
  } catch {
    // branch may already be removed
  }
}

export async function mergeWorktreeBranch(branch: string): Promise<{ merged: boolean; output: string }> {
  try {
    const result = await $`git merge ${branch} --no-edit`.quiet();
    return { merged: true, output: result.text() };
  } catch (error) {
    return { merged: false, output: String(error) };
  }
}
