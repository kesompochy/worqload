import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createPrAction,
  mergeFromBaseAction,
  mergeToBaseAction,
  syncBaseFromRemoteAction,
} from "./actions";
import type { SessionMeta } from "./session";
import { cleanupAll, makeRepoFromTemplate, makeTmpDir } from "./test-helpers";
import { createSessionWorktree } from "./worktree";

afterEach(cleanupAll);

const cleanGitEnv = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };
const TEST_BASE = "trunk";

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: cleanGitEnv });
}

function worktreeStatus(cwd: string): string {
  return new TextDecoder().decode(git(["status", "--porcelain"], cwd).stdout);
}

function makeRepo(opts: { gitignoreWorqloadReports?: boolean } = {}): string {
  const { gitignoreWorqloadReports = true } = opts;
  return makeRepoFromTemplate(`actions-${gitignoreWorqloadReports}`, (dir) => {
    git(["init"], dir);
    git(["checkout", "-b", TEST_BASE], dir);
    git(["config", "user.email", "t@t.com"], dir);
    git(["config", "user.name", "t"], dir);
    writeFileSync(join(dir, "README.md"), "# t\n");
    const ignored = [".worqload/", ".worktrees/", ...(gitignoreWorqloadReports ? [".worqload-reports"] : [])];
    writeFileSync(join(dir, ".gitignore"), `${ignored.join("\n")}\n`);
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
  });
}

async function makeSessionWorktree(repoDir: string, sessionId: string): Promise<SessionMeta> {
  const reportsDir = join(repoDir, ".worqload", "sessions", sessionId, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const branchName = `test-${sessionId.slice(0, 8)}`;
  const { worktreePath } = await createSessionWorktree({
    sessionId,
    repoDir,
    baseBranch: TEST_BASE,
    branchName,
    reportsDirAbsolute: reportsDir,
  });
  return {
    id: sessionId,
    prompt: "do thing",
    title: "do thing",
    baseBranch: TEST_BASE,
    baseCommit: "irrelevant",
    worktreePath,
    branchName,
    status: "running",
    createdAt: new Date().toISOString(),
  };
}

test("merge-from-base merges base branch changes into the session worktree", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  // commit a change on the session branch
  writeFileSync(join(meta.worktreePath, "session-work.txt"), "session work\n");
  git(["add", "session-work.txt"], meta.worktreePath);
  git(["commit", "-m", "session work"], meta.worktreePath);

  // advance the base branch in the main repo
  writeFileSync(join(repoDir, "base-update.txt"), "from base\n");
  git(["add", "base-update.txt"], repoDir);
  git(["commit", "-m", "base branch advance"], repoDir);

  const res = await mergeFromBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(true);

  // session worktree should now have both files
  expect(git(["show", "HEAD:session-work.txt"], meta.worktreePath).exitCode).toBe(0);
  expect(git(["show", "HEAD:base-update.txt"], meta.worktreePath).exitCode).toBe(0);
});

test("merge-from-base refuses when session worktree has uncommitted changes", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  writeFileSync(join(meta.worktreePath, "uncommitted.txt"), "dirty\n");

  const res = await mergeFromBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(false);
  expect(res.message).toContain("uncommitted");
});

test("merge-from-base refuses without touching the session branch when the merge would conflict", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  // both sides edit README.md incompatibly
  writeFileSync(join(meta.worktreePath, "README.md"), "# changed by session\n");
  git(["commit", "-am", "session edits README"], meta.worktreePath);
  writeFileSync(join(repoDir, "README.md"), "# changed on base\n");
  git(["commit", "-am", "base edits README"], repoDir);

  const headBefore = new TextDecoder().decode(git(["rev-parse", "HEAD"], meta.worktreePath).stdout).trim();
  const res = await mergeFromBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(false);
  expect(res.message?.toLowerCase()).toContain("conflict");
  expect(res.message).toContain("README.md");

  // HEAD must not have moved — no half-done merge left behind
  const headAfter = new TextDecoder().decode(git(["rev-parse", "HEAD"], meta.worktreePath).stdout).trim();
  expect(headAfter).toBe(headBefore);
  expect(git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], meta.worktreePath).exitCode).not.toBe(0);
});

test("merge-from-base reports already up to date when base has no new commits", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  const res = await mergeFromBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(true);
  // git merge with no new commits says "Already up to date."
  expect(res.stdout.toLowerCase()).toContain("already up to date");
});

test("merge-from-base does not treat the injected .worqload-reports symlink as dirtiness", async () => {
  const repoDir = makeRepo({ gitignoreWorqloadReports: false });
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  expect(worktreeStatus(meta.worktreePath)).toContain(".worqload-reports");

  // advance base so there is something to merge
  writeFileSync(join(repoDir, "base-update.txt"), "from base\n");
  git(["add", "base-update.txt"], repoDir);
  git(["commit", "-m", "base advance"], repoDir);

  const res = await mergeFromBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(true);
  expect(git(["show", "HEAD:base-update.txt"], meta.worktreePath).exitCode).toBe(0);
});

test("merge-from-base uses a custom commit message when one is supplied", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  writeFileSync(join(meta.worktreePath, "session-work.txt"), "work\n");
  git(["add", "session-work.txt"], meta.worktreePath);
  git(["commit", "-m", "session work"], meta.worktreePath);

  writeFileSync(join(repoDir, "base-update.txt"), "from base\n");
  git(["add", "base-update.txt"], repoDir);
  git(["commit", "-m", "base advance"], repoDir);

  const res = await mergeFromBaseAction.run({ meta, repoDir }, { message: "pick up latest base changes" });
  expect(res.ok).toBe(true);

  const subject = new TextDecoder().decode(git(["log", "-1", "--format=%s"], meta.worktreePath).stdout).trim();
  expect(subject).toBe("pick up latest base changes");
});
