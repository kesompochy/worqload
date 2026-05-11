import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createPrAction, findAction, listActions, mergeToBaseAction } from "./actions";
import type { SessionMeta } from "./session";
import { cleanupAll, makeTmpDir } from "./test-helpers";
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

// gitignoreWorqloadReports defaults to true to mirror the production guide:
// worqload's own artifacts are gitignored so they don't show up as untracked
// when the dirty-check runs. Pass false to model a repo whose maintainer never
// added the `.worqload-reports` line — the dirty-check must still cope.
function makeRepo(opts: { gitignoreWorqloadReports?: boolean } = {}): string {
  const { gitignoreWorqloadReports = true } = opts;
  const dir = makeTmpDir("actions-test");
  git(["init"], dir);
  git(["checkout", "-b", TEST_BASE], dir);
  git(["config", "user.email", "t@t.com"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "README.md"), "# t\n");
  const ignored = [".worqload/", ".worktrees/", ...(gitignoreWorqloadReports ? [".worqload-reports"] : [])];
  writeFileSync(join(dir, ".gitignore"), `${ignored.join("\n")}\n`);
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
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

test("registry exposes built-in actions and supports lookup", () => {
  const list = listActions();
  expect(list.find((a) => a.id === "merge-to-base")).toBeDefined();
  expect(list.find((a) => a.id === "create-pr")).toBeDefined();
  // descriptors must not include the run function
  for (const d of list) {
    expect((d as { run?: unknown }).run).toBeUndefined();
  }
  expect(findAction("merge-to-base")?.id).toBe("merge-to-base");
  expect(findAction("nonexistent")).toBeUndefined();
});

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

test("merge-to-base refuses when session worktree is dirty", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  writeFileSync(join(meta.worktreePath, "uncommitted.txt"), "dirty\n");

  const res = await mergeToBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(false);
  expect(res.message).toContain("uncommitted");
});

test("merge-to-base does not treat the injected .worqload-reports symlink as dirtiness", async () => {
  const repoDir = makeRepo({ gitignoreWorqloadReports: false });
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  // The worktree now carries an untracked `.worqload-reports` symlink, and the
  // repo never gitignored it — but that isn't the agent's work, so the merge
  // must proceed instead of bailing on "uncommitted changes".
  expect(worktreeStatus(meta.worktreePath)).toContain(".worqload-reports");

  const res = await mergeToBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(true);
});

test("merge-to-base refuses when main repo HEAD is not on base branch", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  git(["checkout", "-b", "other"], repoDir);

  const res = await mergeToBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(false);
  expect(res.message).toContain("base branch");
});

test("merge-to-base refuses when main repo has uncommitted changes", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  writeFileSync(join(repoDir, "scratch.txt"), "dirty in main\n");

  const res = await mergeToBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(false);
  expect(res.message).toContain("main repo");
});

test("merge-to-base refuses without touching the base branch when the merge would conflict", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  // Both branches edit README.md at the same lines in incompatible ways.
  writeFileSync(join(meta.worktreePath, "README.md"), "# changed by session\n");
  git(["commit", "-am", "session edits README"], meta.worktreePath);
  writeFileSync(join(repoDir, "README.md"), "# changed in main\n");
  git(["commit", "-am", "main edits README"], repoDir);

  const res = await mergeToBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(false);
  expect(res.message?.toLowerCase()).toContain("conflict");
  expect(res.message).toContain("README.md");

  // The merge must not have started: no MERGE_HEAD, clean tree, README untouched.
  expect(git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], repoDir).exitCode).not.toBe(0);
  expect(new TextDecoder().decode(git(["status", "--porcelain"], repoDir).stdout).trim()).toBe("");
  expect(new TextDecoder().decode(git(["show", `${TEST_BASE}:README.md`], repoDir).stdout)).toBe("# changed in main\n");
});

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
