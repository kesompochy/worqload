import { test, expect, describe, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { mkdirSync, existsSync, readlinkSync, lstatSync, writeFileSync } from "fs";
import { createWorktree, removeWorktree, mergeWorktreeBranch } from "./worktree";

const cleanGitEnv = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: cleanGitEnv });
}

function createTempGitRepo(): string {
  const dir = join(tmpdir(), `worqload-wt-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# test repo\n");
  git(["add", "."], dir);
  git(["commit", "-m", "initial"], dir);
  mkdirSync(join(dir, ".worqload"), { recursive: true });
  writeFileSync(join(dir, ".worqload", "tasks.json"), "[]");
  return dir;
}

const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const dir of cleanupDirs) {
    const result = git(["worktree", "list", "--porcelain"], dir);
    const output = new TextDecoder().decode(result.stdout);
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ") && line.includes(".worktrees")) {
        const wtPath = line.replace("worktree ", "");
        git(["worktree", "remove", "--force", wtPath], dir);
      }
    }
    try {
      const { rmSync } = await import("fs");
      rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  cleanupDirs.length = 0;
});

describe("createWorktree", () => {
  test("creates a git worktree directory", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const taskId = crypto.randomUUID();

    const { worktreePath } = await createWorktree(taskId, repoDir);

    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, ".git"))).toBe(true);
    expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
  });

  test("creates .worqload symlink pointing to main repo", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const taskId = crypto.randomUUID();

    const { worktreePath } = await createWorktree(taskId, repoDir);

    const symlinkPath = join(worktreePath, ".worqload");
    expect(existsSync(symlinkPath)).toBe(true);
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(symlinkPath)).toBe(resolve(repoDir, ".worqload"));
  });

  test("returns branch name based on task ID", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const taskId = crypto.randomUUID();

    const { branchName } = await createWorktree(taskId, repoDir);

    expect(branchName).toBe(`worqload/${taskId.slice(0, 8)}`);
    const result = git(["branch", "--list", branchName], repoDir);
    expect(new TextDecoder().decode(result.stdout).trim()).toContain(taskId.slice(0, 8));
  });

  test("worktree path is under .worktrees/ in repo root", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const taskId = crypto.randomUUID();

    const { worktreePath } = await createWorktree(taskId, repoDir);

    expect(worktreePath).toBe(join(resolve(repoDir), ".worktrees", taskId.slice(0, 8)));
  });

  test("throws when not in a git repo", async () => {
    const dir = join(tmpdir(), `worqload-wt-nogit-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    cleanupDirs.push(dir);

    await expect(createWorktree(crypto.randomUUID(), dir)).rejects.toThrow();
  });
});

describe("removeWorktree", () => {
  test("removes the worktree directory", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const taskId = crypto.randomUUID();

    const { worktreePath, branchName } = await createWorktree(taskId, repoDir);
    expect(existsSync(worktreePath)).toBe(true);

    await removeWorktree(worktreePath, branchName, repoDir);

    expect(existsSync(worktreePath)).toBe(false);
  });

  test("deletes the worktree branch", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const taskId = crypto.randomUUID();

    const { worktreePath, branchName } = await createWorktree(taskId, repoDir);
    await removeWorktree(worktreePath, branchName, repoDir);

    const result = git(["branch", "--list", branchName], repoDir);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("");
  });
});

describe("mergeWorktreeBranch", () => {
  test("merges commits from worktree branch into current branch", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const taskId = crypto.randomUUID();

    const { worktreePath, branchName } = await createWorktree(taskId, repoDir);

    writeFileSync(join(worktreePath, "new-file.txt"), "agent output\n");
    git(["add", "new-file.txt"], worktreePath);
    git(["commit", "-m", "agent commit"], worktreePath);

    const merged = await mergeWorktreeBranch(branchName, repoDir);

    expect(merged).toBe(true);
    expect(existsSync(join(repoDir, "new-file.txt"))).toBe(true);
  });

  test("returns true when no new commits on branch", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const taskId = crypto.randomUUID();

    const { branchName } = await createWorktree(taskId, repoDir);

    const merged = await mergeWorktreeBranch(branchName, repoDir);
    expect(merged).toBe(true);
  });

  test("returns false on merge conflict and aborts", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const taskId = crypto.randomUUID();

    const { worktreePath, branchName } = await createWorktree(taskId, repoDir);

    writeFileSync(join(repoDir, "README.md"), "main branch change\n");
    git(["add", "README.md"], repoDir);
    git(["commit", "-m", "main change"], repoDir);

    writeFileSync(join(worktreePath, "README.md"), "worktree branch change\n");
    git(["add", "README.md"], worktreePath);
    git(["commit", "-m", "worktree change"], worktreePath);

    const merged = await mergeWorktreeBranch(branchName, repoDir);

    expect(merged).toBe(false);
    const status = git(["status", "--porcelain"], repoDir);
    const statusOutput = new TextDecoder().decode(status.stdout).trim();
    const conflictLines = statusOutput.split("\n").filter(l => /^(UU|AA|DD|AU|UA) /.test(l));
    expect(conflictLines).toEqual([]);
  });

  test("concurrent merges of non-conflicting branches both succeed", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);

    const taskA = crypto.randomUUID();
    const taskB = crypto.randomUUID();
    const wtA = await createWorktree(taskA, repoDir);
    const wtB = await createWorktree(taskB, repoDir);

    writeFileSync(join(wtA.worktreePath, "fileA.txt"), "content A\n");
    git(["add", "fileA.txt"], wtA.worktreePath);
    git(["commit", "-m", "add fileA"], wtA.worktreePath);

    writeFileSync(join(wtB.worktreePath, "fileB.txt"), "content B\n");
    git(["add", "fileB.txt"], wtB.worktreePath);
    git(["commit", "-m", "add fileB"], wtB.worktreePath);

    const [mergedA, mergedB] = await Promise.all([
      mergeWorktreeBranch(wtA.branchName, repoDir),
      mergeWorktreeBranch(wtB.branchName, repoDir),
    ]);

    expect(mergedA).toBe(true);
    expect(mergedB).toBe(true);
    expect(existsSync(join(repoDir, "fileA.txt"))).toBe(true);
    expect(existsSync(join(repoDir, "fileB.txt"))).toBe(true);
  });

  test("sequential merges succeed when HEAD advances between merges", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);

    const taskA = crypto.randomUUID();
    const taskB = crypto.randomUUID();
    const wtA = await createWorktree(taskA, repoDir);
    const wtB = await createWorktree(taskB, repoDir);

    writeFileSync(join(wtA.worktreePath, "fileA.txt"), "content A\n");
    git(["add", "fileA.txt"], wtA.worktreePath);
    git(["commit", "-m", "add fileA"], wtA.worktreePath);

    writeFileSync(join(wtB.worktreePath, "fileB.txt"), "content B\n");
    git(["add", "fileB.txt"], wtB.worktreePath);
    git(["commit", "-m", "add fileB"], wtB.worktreePath);

    // Merge A first — HEAD advances
    const mergedA = await mergeWorktreeBranch(wtA.branchName, repoDir);
    expect(mergedA).toBe(true);

    // Merge B after HEAD advanced — should still succeed (non-overlapping files)
    const mergedB = await mergeWorktreeBranch(wtB.branchName, repoDir);
    expect(mergedB).toBe(true);

    expect(existsSync(join(repoDir, "fileA.txt"))).toBe(true);
    expect(existsSync(join(repoDir, "fileB.txt"))).toBe(true);
  });
});
