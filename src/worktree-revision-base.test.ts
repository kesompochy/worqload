import { test, expect, describe, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { mkdirSync, existsSync, readlinkSync, lstatSync, writeFileSync, readFileSync, symlinkSync } from "fs";
import { makeRepoFromTemplate } from "./test-helpers";
import {
  createSessionWorktree,
  removeWorktree,
  resolveBaseCommit,
  currentBranch,
  listWorktreeFiles,
  gitDiff,
  resolveDiffBase,
  listFilesAtRevision,
  readFileAtRevision,
  ensureBaseWorktree,
  baseWorktreePathFor,
} from "./worktree";

const cleanGitEnv = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: cleanGitEnv });
}

const TEST_BASE_BRANCH = "trunk";

function createTempGitRepo(): string {
  return makeRepoFromTemplate("worktree", (dir) => {
    git(["init"], dir);
    git(["checkout", "-b", TEST_BASE_BRANCH], dir);
    git(["config", "user.email", "test@test.com"], dir);
    git(["config", "user.name", "Test"], dir);
    writeFileSync(join(dir, "README.md"), "# test repo\n");
    git(["add", "."], dir);
    git(["commit", "-m", "initial"], dir);
  });
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

describe("ensureBaseWorktree", () => {
  async function makeWorktree(repoDir: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const { worktreePath } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      branchName: `s-${sessionId.slice(0, 8)}`,
      reportsDirAbsolute: join(repoDir, ".worqload", "sessions", sessionId, "reports"),
    });
    return worktreePath;
  }

  test("materialises a sibling worktree at the diff base, with files matching that revision", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "tracked.txt"), "before\n");
    git(["add", "tracked.txt"], repoDir);
    git(["commit", "-m", "tracked v1"], repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    const sessionWorktreePath = await makeWorktree(repoDir);
    // Diverge the session worktree from the base; the base worktree must
    // *not* see this change.
    writeFileSync(join(sessionWorktreePath, "tracked.txt"), "after\n");
    git(["add", "tracked.txt"], sessionWorktreePath);
    git(["commit", "-m", "tracked v2"], sessionWorktreePath);

    const basePath = await ensureBaseWorktree(sessionWorktreePath, repoDir, baseCommit);
    expect(basePath).toBe(baseWorktreePathFor(sessionWorktreePath));
    expect(existsSync(basePath)).toBe(true);
    expect(await Bun.file(join(basePath, "tracked.txt")).text()).toBe("before\n");
  });

  test("re-uses the cached worktree on a second call with the same base commit", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    const sessionWorktreePath = await makeWorktree(repoDir);

    const first = await ensureBaseWorktree(sessionWorktreePath, repoDir, baseCommit);
    // Drop a marker file in the base worktree; a re-add would wipe it.
    writeFileSync(join(first, "marker.tmp"), "x");
    const second = await ensureBaseWorktree(sessionWorktreePath, repoDir, baseCommit);
    expect(second).toBe(first);
    expect(existsSync(join(second, "marker.tmp"))).toBe(true);
  });

  test("recreates the worktree when the diff base has moved", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const firstBase = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    const sessionWorktreePath = await makeWorktree(repoDir);
    await ensureBaseWorktree(sessionWorktreePath, repoDir, firstBase);

    // Advance the base branch and resolve a fresh base commit.
    writeFileSync(join(repoDir, "advance.txt"), "x\n");
    git(["add", "advance.txt"], repoDir);
    git(["commit", "-m", "advance trunk"], repoDir);
    const secondBase = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    expect(secondBase).not.toBe(firstBase);

    const updated = await ensureBaseWorktree(sessionWorktreePath, repoDir, secondBase);
    expect(existsSync(join(updated, "advance.txt"))).toBe(true);
  });
});

