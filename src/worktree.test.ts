import { test, expect, describe, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { mkdirSync, existsSync, readlinkSync, lstatSync, writeFileSync, symlinkSync } from "fs";
import {
  createSessionWorktree,
  removeWorktree,
  resolveBaseCommit,
  currentBranch,
  listWorktreeFiles,
  readWorktreeFile,
  gitDiff,
  resolveDiffBase,
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
      branchName: `test-${sessionId.slice(0, 8)}`,
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
      branchName: `test-${sessionId.slice(0, 8)}`,
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
    await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      branchName: `test-${sessionId.slice(0, 8)}`,
      reportsDirAbsolute: reportsDir,
    });
    expect(existsSync(reportsDir)).toBe(true);
  });

  test("uses the supplied branch name verbatim", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const sessionId = crypto.randomUUID();
    const reportsDir = join(repoDir, ".worqload", "sessions", sessionId, "reports");
    const requested = "fix-login-bug";

    const { branchName } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      branchName: requested,
      reportsDirAbsolute: reportsDir,
    });
    expect(branchName).toBe(requested);
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
      branchName: `test-${sessionId.slice(0, 8)}`,
      reportsDirAbsolute: reportsDir,
    });
    expect(existsSync(worktreePath)).toBe(true);

    await removeWorktree(worktreePath, branchName, repoDir);

    expect(existsSync(worktreePath)).toBe(false);
    const result = git(["branch", "--list", branchName], repoDir);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("");
  });
});

describe("listWorktreeFiles", () => {
  test("lists tracked and untracked files, excluding gitignored ones", async () => {
    const repoDir = createTempGitRepo(); // README.md committed by setup
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, ".gitignore"), "ignored/\n*.log\n");
    mkdirSync(join(repoDir, "ignored"), { recursive: true });
    writeFileSync(join(repoDir, "ignored", "secret.txt"), "x");
    writeFileSync(join(repoDir, "debug.log"), "x");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.ts"), "x");
    git(["add", "src/a.ts"], repoDir); // tracked but uncommitted
    writeFileSync(join(repoDir, "new file.txt"), "x"); // untracked, not ignored, has a space

    const files = await listWorktreeFiles(repoDir);
    expect(files).toContain("README.md");
    expect(files).toContain("src/a.ts");
    expect(files).toContain(".gitignore");
    expect(files).toContain("new file.txt");
    expect(files).not.toContain("ignored/secret.txt");
    expect(files).not.toContain("debug.log");
    expect(files).toEqual([...files].sort());
  });

  test("returns an empty list when the worktree directory is gone", async () => {
    const files = await listWorktreeFiles(join(tmpdir(), `worqload-missing-${crypto.randomUUID()}`));
    expect(files).toEqual([]);
  });
});

describe("readWorktreeFile", () => {
  test("returns text content for a regular file", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "hello.txt"), "line1\nline2\n");
    expect(await readWorktreeFile(repoDir, "hello.txt")).toEqual({ kind: "text", content: "line1\nline2\n" });
  });

  test("rejects paths that escape the worktree", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const escaping = await readWorktreeFile(repoDir, `${"../".repeat(20)}etc/hosts`);
    expect(escaping.kind).toBe("denied");
    const absolute = await readWorktreeFile(repoDir, "/etc/hosts");
    expect(absolute.kind).toBe("denied");
  });

  test("rejects symlinks that point outside the worktree", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const outside = join(tmpdir(), `worqload-outside-${crypto.randomUUID()}.txt`);
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(repoDir, "leak"));
    expect((await readWorktreeFile(repoDir, "leak")).kind).toBe("denied");
  });

  test("returns not-found for a missing file", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    expect((await readWorktreeFile(repoDir, "nope.txt")).kind).toBe("not-found");
  });

  test("returns not-a-file for a directory", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    mkdirSync(join(repoDir, "adir"));
    expect((await readWorktreeFile(repoDir, "adir")).kind).toBe("not-a-file");
  });

  test("flags binary files", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "bin.dat"), Buffer.from([0x68, 0x69, 0x00, 0x01, 0xff]));
    expect((await readWorktreeFile(repoDir, "bin.dat")).kind).toBe("binary");
  });

  test("flags files over the size limit", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "big.txt"), "a".repeat(3 * 1024 * 1024));
    const result = await readWorktreeFile(repoDir, "big.txt");
    expect(result.kind).toBe("too-large");
    if (result.kind === "too-large") expect(result.size).toBe(3 * 1024 * 1024);
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
