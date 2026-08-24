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

function attachOriginWithPeer(repoDir: string): string {
  const bare = makeTmpDir("actions-bare-origin");
  // re-init as bare; makeTmpDir hands us an empty dir
  rmSync(bare, { recursive: true, force: true });
  mkdirSync(bare, { recursive: true });
  git(["init", "--bare", "-b", TEST_BASE], bare);
  git(["remote", "add", "origin", bare], repoDir);
  // Push the base branch so origin/<base> exists locally and the bare repo has it.
  git(["push", "-u", "origin", TEST_BASE], repoDir);

  const peer = makeTmpDir("actions-origin-peer");
  git(["clone", bare, peer], process.cwd());
  git(["config", "user.email", "peer@t.com"], peer);
  git(["config", "user.name", "peer"], peer);
  return peer;
}

function advanceOriginBase(peer: string, fileName: string, body: string, message: string): void {
  writeFileSync(join(peer, fileName), body);
  git(["add", fileName], peer);
  git(["commit", "-m", message], peer);
  git(["push", "origin", TEST_BASE], peer);
}

test("sync-base-from-remote fast-forwards the local base branch when main repo is on it", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);
  const peer = attachOriginWithPeer(repoDir);

  advanceOriginBase(peer, "from-origin.txt", "shipped on origin\n", "advance base on origin");

  const res = await syncBaseFromRemoteAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(true);

  // The local base branch now contains the file pushed via origin.
  expect(git(["show", `${TEST_BASE}:from-origin.txt`], repoDir).exitCode).toBe(0);
});

test("sync-base-from-remote updates the local base branch when main repo is on a different branch", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);
  const peer = attachOriginWithPeer(repoDir);

  // Main repo isn't sitting on the base branch.
  git(["checkout", "-b", "feature/elsewhere"], repoDir);

  advanceOriginBase(peer, "from-origin.txt", "shipped on origin\n", "advance base on origin");

  const res = await syncBaseFromRemoteAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(true);

  // The local base branch (not currently checked out) advanced to match origin.
  expect(git(["show", `${TEST_BASE}:from-origin.txt`], repoDir).exitCode).toBe(0);
});

test("sync-base-from-remote fast-forwards even when the main repo has unrelated uncommitted changes", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);
  const peer = attachOriginWithPeer(repoDir);

  // Uncommitted scratch work in the main repo that touches no file origin will
  // bring in — git's own fast-forward can handle this and we must not pre-empt it.
  writeFileSync(join(repoDir, "scratch.txt"), "in-progress local work\n");

  advanceOriginBase(peer, "from-origin.txt", "shipped on origin\n", "advance base on origin");

  const res = await syncBaseFromRemoteAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(true);
  expect(git(["show", `${TEST_BASE}:from-origin.txt`], repoDir).exitCode).toBe(0);
  // The scratch work is still sitting uncommitted in the worktree.
  expect(worktreeStatus(repoDir)).toContain("scratch.txt");
});

test("sync-base-from-remote surfaces the git error when no origin remote is configured", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  const res = await syncBaseFromRemoteAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(false);
  const errText = `${res.stderr} ${res.stdout}`.toLowerCase();
  expect(errText).toMatch(/origin|remote/);
});

