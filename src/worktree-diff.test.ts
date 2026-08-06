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

describe("gitDiff", () => {
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

  test("against the session-start commit, shows the branch's committed and uncommitted changes", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const worktreePath = await makeWorktree(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    writeFileSync(join(worktreePath, "committed.txt"), "committed work\n");
    git(["add", "committed.txt"], worktreePath);
    git(["commit", "-m", "session change"], worktreePath);
    writeFileSync(join(worktreePath, "README.md"), "# uncommitted edit\n");

    const diff = await gitDiff(worktreePath, baseCommit);
    expect(diff).toContain("committed.txt");
    expect(diff).toContain("committed work");
    expect(diff).toContain("uncommitted edit");
  });

  test("commits the base branch gained after the fork don't appear (the recorded base commit is fixed)", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const worktreePath = await makeWorktree(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    writeFileSync(join(worktreePath, "session-file.txt"), "session work\n");
    git(["add", "session-file.txt"], worktreePath);
    git(["commit", "-m", "session change"], worktreePath);

    // The base branch advances past the fork point — e.g. another session merged in.
    writeFileSync(join(repoDir, "other-session.txt"), "work from another session\n");
    git(["add", "other-session.txt"], repoDir);
    git(["commit", "-m", "merge another session"], repoDir);

    const diff = await gitDiff(worktreePath, baseCommit);
    expect(diff).toContain("session-file.txt");
    expect(diff).not.toContain("other-session.txt");
  });

  test("with a large context value emits the whole file, not just lines around the change", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);

    // 30-line file on the base branch; change one line deep in the middle in the
    // worktree. `git diff -U3` would hide most of the file; a huge -U value
    // means "all of it" — what the diff view wants so the human can expand
    // context locally.
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(repoDir, "many.txt"), lines.join("\n") + "\n");
    git(["add", "many.txt"], repoDir);
    git(["commit", "-m", "add many.txt"], repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    const worktreePath = await makeWorktree(repoDir);
    const changed = [...lines];
    changed[14] = "line 15 CHANGED";
    writeFileSync(join(worktreePath, "many.txt"), changed.join("\n") + "\n");

    const diff = await gitDiff(worktreePath, baseCommit, 1_000_000);
    expect(diff).toContain("line 15 CHANGED");
    expect(diff).toContain("line 1");
    expect(diff).toContain("line 30");
  });
});

describe("resolveDiffBase", () => {
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

  function revParse(ref: string, cwd: string): string {
    return new TextDecoder().decode(git(["rev-parse", ref], cwd).stdout).trim();
  }

  test("returns the recorded base commit when nothing has moved", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const worktreePath = await makeWorktree(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    expect(await resolveDiffBase(worktreePath, TEST_BASE_BRANCH, baseCommit)).toBe(baseCommit);
  });

  test("ignores base-branch commits that haven't been merged into the branch", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const worktreePath = await makeWorktree(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    writeFileSync(join(repoDir, "other.txt"), "other\n");
    git(["add", "other.txt"], repoDir);
    git(["commit", "-m", "base branch advances"], repoDir);

    expect(await resolveDiffBase(worktreePath, TEST_BASE_BRANCH, baseCommit)).toBe(baseCommit);
  });

  test("moves forward to the absorbed tip after the base branch is merged in (update branch)", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const worktreePath = await makeWorktree(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    writeFileSync(join(worktreePath, "session.txt"), "session\n");
    git(["add", "session.txt"], worktreePath);
    git(["commit", "-m", "session change"], worktreePath);

    writeFileSync(join(repoDir, "other.txt"), "other\n");
    git(["add", "other.txt"], repoDir);
    git(["commit", "-m", "base branch advances"], repoDir);
    const advancedTip = revParse(TEST_BASE_BRANCH, repoDir);

    git(["merge", "--no-edit", TEST_BASE_BRANCH], worktreePath);

    expect(await resolveDiffBase(worktreePath, TEST_BASE_BRANCH, baseCommit)).toBe(advancedTip);
  });

  test("keeps the recorded base commit when the base branch trails it", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    // Fork the worktree from an advanced trunk, then rewind trunk behind that point.
    writeFileSync(join(repoDir, "ahead.txt"), "ahead\n");
    git(["add", "ahead.txt"], repoDir);
    git(["commit", "-m", "trunk moves ahead"], repoDir);
    const worktreePath = await makeWorktree(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    git(["reset", "--hard", "HEAD~1"], repoDir);

    expect(await resolveDiffBase(worktreePath, TEST_BASE_BRANCH, baseCommit)).toBe(baseCommit);
  });
});

