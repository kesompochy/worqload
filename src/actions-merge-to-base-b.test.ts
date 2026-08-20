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

test("dirty-check treats files in .worqload-draft as not-the-agent's-work, so merge-to-base proceeds", async () => {
  const repoDir = makeRepo();
  const sessionId = crypto.randomUUID();
  const meta = await makeSessionWorktree(repoDir, sessionId);

  // Drafts live in .worqload-draft/ as session-private scratch space. They
  // must not block merge-to-base or land in an auto-commit.
  writeFileSync(join(meta.worktreePath, ".worqload-draft", "010-progress.md"), "draft body\n");
  expect(worktreeStatus(meta.worktreePath)).toContain(".worqload-draft");

  const res = await mergeToBaseAction.run({ meta, repoDir }, {});
  expect(res.ok).toBe(true);
});

