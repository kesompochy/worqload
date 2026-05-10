import { test, expect, describe, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { mkdirSync, existsSync, readlinkSync, lstatSync, writeFileSync } from "fs";
import {
  createSessionWorktree,
  removeWorktree,
  resolveBaseCommit,
  currentBranch,
} from "./worktree";

const cleanGitEnv = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: cleanGitEnv });
}

// The base branch is "trunk" rather than "main"/"master" so commits made by
// the test setup don't trip the user's global pre-commit branch-protection hook.
const TEST_BASE_BRANCH = "trunk";

function createTempGitRepo(): string {
  const dir = join(tmpdir(), `worqload-wt-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  git(["init"], dir);
  git(["checkout", "-b", TEST_BASE_BRANCH], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# test repo\n");
  git(["add", "."], dir);
  git(["commit", "-m", "initial"], dir);
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

describe("createSessionWorktree", () => {
  test("creates a git worktree directory at <repo>/.worktrees/<shortId>", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const sessionId = crypto.randomUUID();
    const reportsDir = join(repoDir, ".worqload", "sessions", sessionId, "reports");

    const { worktreePath } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      reportsDirAbsolute: reportsDir,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
    expect(worktreePath).toBe(join(resolve(repoDir), ".worktrees", sessionId.slice(0, 8)));
  });

  test("creates .worqload-reports symlink pointing to reports dir", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const sessionId = crypto.randomUUID();
    const reportsDir = resolve(join(repoDir, ".worqload", "sessions", sessionId, "reports"));

    const { worktreePath } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      reportsDirAbsolute: reportsDir,
    });

    const linkPath = join(worktreePath, ".worqload-reports");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(reportsDir);
  });

  test("creates the reports directory if missing", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const sessionId = crypto.randomUUID();
    const reportsDir = join(repoDir, ".worqload", "sessions", sessionId, "reports");

    expect(existsSync(reportsDir)).toBe(false);
    await createSessionWorktree({ sessionId, repoDir, baseBranch: TEST_BASE_BRANCH, reportsDirAbsolute: reportsDir });
    expect(existsSync(reportsDir)).toBe(true);
  });

  test("returns branch name worqload/<shortId>", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const sessionId = crypto.randomUUID();
    const reportsDir = join(repoDir, ".worqload", "sessions", sessionId, "reports");

    const { branchName } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      reportsDirAbsolute: reportsDir,
    });
    expect(branchName).toBe(`worqload/${sessionId.slice(0, 8)}`);
  });
});

describe("removeWorktree", () => {
  test("removes the worktree directory and the branch", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const sessionId = crypto.randomUUID();
    const reportsDir = join(repoDir, ".worqload", "sessions", sessionId, "reports");

    const { worktreePath, branchName } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      reportsDirAbsolute: reportsDir,
    });
    expect(existsSync(worktreePath)).toBe(true);

    await removeWorktree(worktreePath, branchName, repoDir);

    expect(existsSync(worktreePath)).toBe(false);
    const result = git(["branch", "--list", branchName], repoDir);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("");
  });
});

describe("resolveBaseCommit / currentBranch", () => {
  test("resolveBaseCommit returns commit sha", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);

    const sha = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("currentBranch returns main on freshly initialised repo", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);

    const branch = await currentBranch(repoDir);
    expect(branch).toBe(TEST_BASE_BRANCH);
  });
});
