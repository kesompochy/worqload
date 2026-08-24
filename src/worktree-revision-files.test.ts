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

describe("listFilesAtRevision / readFileAtRevision", () => {
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

  test("lists tracked files as they existed at the given revision, ignoring later worktree changes", async () => {
    const repoDir = createTempGitRepo(); // commit: README.md
    cleanupDirs.push(repoDir);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.ts"), "export const a = 1\n");
    git(["add", "src/a.ts"], repoDir);
    git(["commit", "-m", "add a"], repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    const worktreePath = await makeWorktree(repoDir);
    // After the fork, add and remove files in the worktree — these must not
    // appear in the Before snapshot.
    writeFileSync(join(worktreePath, "src", "b.ts"), "export const b = 2\n");
    git(["add", "src/b.ts"], worktreePath);
    git(["commit", "-m", "add b"], worktreePath);
    git(["rm", "src/a.ts"], worktreePath);
    git(["commit", "-m", "remove a"], worktreePath);

    const before = await listFilesAtRevision(worktreePath, baseCommit);
    expect(before).toContain("README.md");
    expect(before).toContain("src/a.ts");
    expect(before).not.toContain("src/b.ts");
  });

  test("returns an empty list when the revision can't be resolved", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const worktreePath = await makeWorktree(repoDir);
    expect(await listFilesAtRevision(worktreePath, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toEqual([]);
  });

  test("reads the file blob as it existed at the given revision", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "hello.txt"), "before\n");
    git(["add", "hello.txt"], repoDir);
    git(["commit", "-m", "before"], repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    const worktreePath = await makeWorktree(repoDir);
    writeFileSync(join(worktreePath, "hello.txt"), "after\n");
    git(["add", "hello.txt"], worktreePath);
    git(["commit", "-m", "after"], worktreePath);

    expect(await readFileAtRevision(worktreePath, baseCommit, "hello.txt")).toEqual({ kind: "text", content: "before\n" });
  });

  test("returns not-found for files that did not exist at the revision", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    const worktreePath = await makeWorktree(repoDir);
    writeFileSync(join(worktreePath, "new.txt"), "new\n");
    git(["add", "new.txt"], worktreePath);
    git(["commit", "-m", "new"], worktreePath);

    expect((await readFileAtRevision(worktreePath, baseCommit, "new.txt")).kind).toBe("not-found");
  });

  test("rejects paths that escape the repo", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    const worktreePath = await makeWorktree(repoDir);

    expect((await readFileAtRevision(worktreePath, baseCommit, "../etc/hosts")).kind).toBe("denied");
    expect((await readFileAtRevision(worktreePath, baseCommit, "/etc/hosts")).kind).toBe("denied");
    expect((await readFileAtRevision(worktreePath, baseCommit, "")).kind).toBe("denied");
  });

  test("flags binary blobs without buffering them as text", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "bin.dat"), Buffer.from([0x68, 0x69, 0x00, 0x01, 0xff]));
    git(["add", "bin.dat"], repoDir);
    git(["commit", "-m", "add bin"], repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    const worktreePath = await makeWorktree(repoDir);

    expect((await readFileAtRevision(worktreePath, baseCommit, "bin.dat")).kind).toBe("binary");
  });
});

