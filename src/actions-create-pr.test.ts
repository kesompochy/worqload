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

test("create-pr returns the failing git push output when there is no origin remote", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  writeFileSync(join(meta.worktreePath, "feature.txt"), "x\n");
  git(["add", "feature.txt"], meta.worktreePath);
  git(["commit", "-m", "x"], meta.worktreePath);

  const res = await createPrAction.run({ meta, repoDir }, { title: "t", body: "b" });
  expect(res.ok).toBe(false);
  // git push prints the missing-remote error to stderr
  expect(res.stderr.toLowerCase()).toMatch(/origin|remote/);
  // and we annotate that gh was not attempted
  expect(res.message).toContain("gh pr create");
});

test("create-pr commits the agent's uncommitted worktree changes before pushing", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  // the agent left a change uncommitted in the worktree
  writeFileSync(join(meta.worktreePath, "feature.txt"), "left uncommitted\n");

  // push still fails (the test repo has no origin remote), but the commit must
  // have happened first under the PR title
  const res = await createPrAction.run({ meta, repoDir }, { title: "my pr title", body: "" });
  expect(res.ok).toBe(false);
  expect(res.stderr.toLowerCase()).toMatch(/origin|remote/);
  expect(worktreeStatus(meta.worktreePath).trim()).toBe("");
  expect(new TextDecoder().decode(git(["log", "--oneline"], meta.worktreePath).stdout)).toContain("my pr title");
  expect(git(["show", "HEAD:feature.txt"], meta.worktreePath).exitCode).toBe(0);
});


test("create-pr auto-commit leaves .worqload-draft contents out of the commit", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  writeFileSync(join(meta.worktreePath, ".worqload-draft", "010-progress.md"), "draft body\n");
  writeFileSync(join(meta.worktreePath, "feature.txt"), "real work\n");

  const res = await createPrAction.run({ meta, repoDir }, { title: "pr title", body: "" });
  expect(res.ok).toBe(false); // push fails: no origin remote
  // the real change is committed...
  expect(git(["show", "HEAD:feature.txt"], meta.worktreePath).exitCode).toBe(0);
  // ...but the draft is not, and is left sitting untracked
  expect(git(["show", "HEAD:.worqload-draft/010-progress.md"], meta.worktreePath).exitCode).not.toBe(0);
  expect(worktreeStatus(meta.worktreePath)).toContain(".worqload-draft");
});

test("create-pr auto-commit excludes the .worqload-reports symlink even when the repo hasn't gitignored it", async () => {
  const repoDir = makeRepo({ gitignoreWorqloadReports: false });
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  // worktree carries both the injected symlink and a real uncommitted change
  expect(worktreeStatus(meta.worktreePath)).toContain(".worqload-reports");
  writeFileSync(join(meta.worktreePath, "feature.txt"), "left uncommitted\n");

  const res = await createPrAction.run({ meta, repoDir }, { title: "pr title", body: "" });
  expect(res.ok).toBe(false); // push fails: no origin remote
  expect(res.stderr.toLowerCase()).toMatch(/origin|remote/);
  // the real change is committed...
  expect(git(["show", "HEAD:feature.txt"], meta.worktreePath).exitCode).toBe(0);
  expect(new TextDecoder().decode(git(["log", "--oneline"], meta.worktreePath).stdout)).toContain("pr title");
  // ...but the symlink is not, and is left sitting untracked
  expect(git(["show", "HEAD:.worqload-reports"], meta.worktreePath).exitCode).not.toBe(0);
  expect(worktreeStatus(meta.worktreePath)).toContain(".worqload-reports");
});

