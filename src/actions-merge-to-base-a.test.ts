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

test("merge-to-base merges the session branch when preconditions are satisfied", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  // commit a change inside the session worktree
  writeFileSync(join(meta.worktreePath, "feature.txt"), "added by session\n");
  git(["add", "feature.txt"], meta.worktreePath);
  git(["commit", "-m", "session work"], meta.worktreePath);

  const res = await mergeToBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(true);

  // base branch HEAD should now contain the file
  const log = git(["log", "--all", "--oneline"], repoDir);
  expect(new TextDecoder().decode(log.stdout)).toContain("session work");
  // base branch should have the file checked out
  const showResult = git(["show", `${TEST_BASE}:feature.txt`], repoDir);
  expect(showResult.exitCode).toBe(0);
});

test("merge-to-base defaults the merge commit message to the session name", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  writeFileSync(join(meta.worktreePath, "feature.txt"), "added by session\n");
  git(["add", "feature.txt"], meta.worktreePath);
  git(["commit", "-m", "session work"], meta.worktreePath);

  const res = await mergeToBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(true);

  const subject = new TextDecoder().decode(git(["log", "-1", "--format=%s"], repoDir).stdout).trim();
  expect(subject).toBe(`Merge session ${sessionId.slice(0, 8)}: ${meta.title}`);
});

test("merge-to-base uses a custom commit message when one is supplied", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  writeFileSync(join(meta.worktreePath, "feature.txt"), "added by session\n");
  git(["add", "feature.txt"], meta.worktreePath);
  git(["commit", "-m", "session work"], meta.worktreePath);

  const res = await mergeToBaseAction.run({ meta, repoDir }, { message: "ship the parser rewrite\n\ncloses #42" });
  expect(res.ok).toBe(true);

  const body = new TextDecoder().decode(git(["log", "-1", "--format=%B"], repoDir).stdout).trim();
  expect(body).toBe("ship the parser rewrite\n\ncloses #42");
});

test("merge-to-base falls back to the default message when the supplied message is blank", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  writeFileSync(join(meta.worktreePath, "feature.txt"), "added by session\n");
  git(["add", "feature.txt"], meta.worktreePath);
  git(["commit", "-m", "session work"], meta.worktreePath);

  const res = await mergeToBaseAction.run({ meta, repoDir }, { message: "   \n  " });
  expect(res.ok).toBe(true);

  const subject = new TextDecoder().decode(git(["log", "-1", "--format=%s"], repoDir).stdout).trim();
  expect(subject).toBe(`Merge session ${sessionId.slice(0, 8)}: ${meta.title}`);
});

test("merge-to-base refuses when session worktree is dirty", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  writeFileSync(join(meta.worktreePath, "uncommitted.txt"), "dirty\n");

  const res = await mergeToBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(false);
  expect(res.message).toContain("uncommitted");
});
