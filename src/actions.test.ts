import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createPrAction,
  findAction,
  isSessionPreviewAlive,
  listActions,
  mergeFromBaseAction,
  mergeToBaseAction,
  parsePreviewListeningUrl,
  previewAction,
  previewPortForSession,
  stopPreviewAction,
  stopSessionPreview,
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

// gitignoreWorqloadReports defaults to true to mirror the production guide:
// worqload's own artifacts are gitignored so they don't show up as untracked
// when the dirty-check runs. Pass false to model a repo whose maintainer never
// added the `.worqload-reports` line — the dirty-check must still cope.
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

test("registry exposes built-in actions and supports lookup", () => {
  const list = listActions();
  expect(list.find((a) => a.id === "merge-to-base")).toBeDefined();
  expect(list.find((a) => a.id === "merge-from-base")).toBeDefined();
  expect(list.find((a) => a.id === "create-pr")).toBeDefined();
  expect(list.find((a) => a.id === "sync-base-from-remote")).toBeDefined();
  expect(list.find((a) => a.id === "preview")?.direct).toBe(true);
  expect(list.find((a) => a.id === "stop-preview")?.direct).toBe(true);
  // panel actions stay non-direct
  expect(list.find((a) => a.id === "merge-to-base")?.direct).toBeUndefined();
  expect(list.find((a) => a.id === "sync-base-from-remote")?.direct).toBeUndefined();
  // descriptors must not include the run function or the availableFor predicate
  for (const d of list) {
    expect((d as { run?: unknown }).run).toBeUndefined();
    expect((d as { availableFor?: unknown }).availableFor).toBeUndefined();
  }
  expect(findAction("merge-to-base")?.id).toBe("merge-to-base");
  expect(findAction("nonexistent")).toBeUndefined();
});

test("previewPortForSession is stable, in range, and varies by session", () => {
  const a = previewPortForSession("11111111-2222-3333-4444-555555555555");
  const b = previewPortForSession("11111111-2222-3333-4444-555555555555");
  const c = previewPortForSession("99999999-8888-7777-6666-555555555555");
  expect(a).toBe(b);
  expect(a).toBeGreaterThanOrEqual(3500);
  expect(a).toBeLessThan(3700);
  expect(a).not.toBe(c);
});

test("parsePreviewListeningUrl pulls the URL out of the server's startup log", () => {
  expect(parsePreviewListeningUrl("worqload preview listening on http://127.0.0.1:3517\npreview repo: /x\n")).toBe(
    "http://127.0.0.1:3517",
  );
  expect(parsePreviewListeningUrl("building...\n")).toBeNull();
});

function metaWithWorktree(worktreePath: string): SessionMeta {
  return {
    id: crypto.randomUUID(),
    prompt: "p",
    title: "p",
    baseBranch: "main",
    baseCommit: "x",
    worktreePath,
    branchName: "b",
    status: "running",
    createdAt: new Date().toISOString(),
  };
}

test("preview / stop-preview are offered only for worqload checkouts", () => {
  const plain = makeTmpDir("actions-plain-worktree");
  expect(previewAction.availableFor?.({ meta: metaWithWorktree(plain), repoDir: plain })).toBe(false);
  expect(stopPreviewAction.availableFor?.({ meta: metaWithWorktree(plain), repoDir: plain })).toBe(false);

  const worqload = makeTmpDir("actions-worqload-worktree");
  mkdirSync(join(worqload, "src", "commands"), { recursive: true });
  writeFileSync(join(worqload, "src", "commands", "preview.ts"), "");
  mkdirSync(join(worqload, "preview-seed"), { recursive: true });
  expect(previewAction.availableFor?.({ meta: metaWithWorktree(worqload), repoDir: worqload })).toBe(true);
  expect(stopPreviewAction.availableFor?.({ meta: metaWithWorktree(worqload), repoDir: worqload })).toBe(true);
});

test("stop-preview reports cleanly when no preview is running for the session", async () => {
  process.env.WORQLOAD_PREVIEW_DIR = makeTmpDir("actions-preview-root");
  try {
    const res = await stopPreviewAction.run({ meta: metaWithWorktree("/irrelevant"), repoDir: "/irrelevant" }, {});
    expect(res.ok).toBe(true);
    expect(res.message).toContain("no preview server");
  } finally {
    delete process.env.WORQLOAD_PREVIEW_DIR;
  }
});

// The pidfile lives under <previewRoot>/<shortId>/.worqload/preview.pid; that
// path mirrors `previewPaths()` exactly so the helper under test reads the
// file we just wrote.
function writePreviewPid(root: string, sessionId: string, pid: number, logBody?: string): void {
  const shortId = sessionId.slice(0, 8);
  const dir = join(root, shortId, ".worqload");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "preview.pid"), String(pid));
  if (logBody !== undefined) writeFileSync(join(root, `${shortId}.log`), logBody);
}

test("isSessionPreviewAlive returns alive=false when no pidfile is present", () => {
  process.env.WORQLOAD_PREVIEW_DIR = makeTmpDir("actions-preview-alive-empty");
  try {
    const status = isSessionPreviewAlive(metaWithWorktree("/irrelevant"));
    expect(status.alive).toBe(false);
  } finally {
    delete process.env.WORQLOAD_PREVIEW_DIR;
  }
});

test("isSessionPreviewAlive returns alive=false when the pidfile points at a dead process", () => {
  const root = makeTmpDir("actions-preview-alive-stale");
  process.env.WORQLOAD_PREVIEW_DIR = root;
  try {
    const meta = metaWithWorktree("/irrelevant");
    // pid 2**31 - 1 is well above any conceivable live pid on the test host.
    writePreviewPid(root, meta.id, 2_147_483_646);
    const status = isSessionPreviewAlive(meta);
    expect(status.alive).toBe(false);
  } finally {
    delete process.env.WORQLOAD_PREVIEW_DIR;
  }
});

test("isSessionPreviewAlive surfaces the pid and parses the listening URL from the log when the process is alive", () => {
  const root = makeTmpDir("actions-preview-alive-live");
  process.env.WORQLOAD_PREVIEW_DIR = root;
  try {
    const meta = metaWithWorktree("/irrelevant");
    writePreviewPid(root, meta.id, process.pid, "worqload preview listening on http://127.0.0.1:3501\n");
    const status = isSessionPreviewAlive(meta);
    expect(status.alive).toBe(true);
    if (status.alive) {
      expect(status.pid).toBe(process.pid);
      expect(status.url).toBe("http://127.0.0.1:3501");
    }
  } finally {
    delete process.env.WORQLOAD_PREVIEW_DIR;
  }
});

test("stopSessionPreview returns null when there's nothing to stop", async () => {
  process.env.WORQLOAD_PREVIEW_DIR = makeTmpDir("actions-preview-stop-empty");
  try {
    const pid = await stopSessionPreview(metaWithWorktree("/irrelevant"));
    expect(pid).toBeNull();
  } finally {
    delete process.env.WORQLOAD_PREVIEW_DIR;
  }
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

// Stand up a bare repo as `origin`, plus a peer clone that lets a test push
// new commits to it so the sync-base action has something to pull. Returns the
// peer-clone path so the test can advance origin's base branch through it.
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
