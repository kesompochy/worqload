import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionMeta } from "./session";
import { HIDDEN_WORKTREE_ENTRIES } from "./worktree";

// Pathspecs that drop worqload's own injected worktree entries (the
// `.worqload-reports` symlink) from `git status`, so a repo that hasn't
// gitignored them still gets an honest read of whether the agent left work
// uncommitted. Mirrors HIDDEN_WORKTREE_ENTRIES used by the file explorer.
const WORQLOAD_ENTRY_EXCLUDES = [...HIDDEN_WORKTREE_ENTRIES].map((entry) => `:!${entry}`);

export interface ActionResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  message?: string;
}

export interface ActionContext {
  meta: SessionMeta;
  repoDir: string;
}

export interface ActionParamSpec {
  name: string;
  label: string;
  type: "string" | "text";
  required?: boolean;
  default?: string;
  placeholder?: string;
}

export interface Action {
  id: string;
  label: string;
  description?: string;
  confirmMessage?: string;
  // Direct actions run on a single button click — no inline panel, no
  // "Confirm & Run" step. Only for parameterless, cheap, reversible actions
  // (preview / stop-preview); their result surfaces as a toast and an
  // action_invoked event rather than in a panel.
  direct?: boolean;
  params?: ActionParamSpec[];
  group?: string;
  // When present, the action is offered for a session only if this returns
  // true (e.g. preview is only meaningful when the session's worktree is a
  // worqload checkout). Absent = always offered.
  availableFor?(ctx: ActionContext): boolean;
  run(ctx: ActionContext, params: Record<string, string>): Promise<ActionResult>;
}

export interface ActionDescriptor {
  id: string;
  label: string;
  description?: string;
  confirmMessage?: string;
  direct?: boolean;
  params?: ActionParamSpec[];
  // Visual grouping cue for the action button row. Buttons sharing a `group`
  // render tight; a group change inserts a separator. Absent = its own group.
  group?: string;
}

function cleanGitEnv(): Record<string, string | undefined> {
  return { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };
}

async function runCommand(args: string[], cwd: string): Promise<ActionResult> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", env: cleanGitEnv() });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, exitCode, stdout, stderr };
}

function fail(message: string): ActionResult {
  return { ok: false, exitCode: -1, stdout: "", stderr: "", message };
}

// "dirty" includes untracked (non-gitignored) files because we want to catch
// the case where the agent edited but forgot to commit. The `.worqload-reports`
// symlink worqload injects at the worktree root is excluded: it isn't project
// content, so a repo that hasn't gitignored it still gets a clean check.
async function isWorktreeDirty(cwd: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "status", "--porcelain", "--", ".", ...WORQLOAD_ENTRY_EXCLUDES], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: cleanGitEnv(),
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim() !== "";
}

async function gitCurrentBranch(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: cleanGitEnv(),
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

type MergeProbe =
  | { status: "clean" }
  | { status: "conflict"; files: string[]; output: string }
  | { status: "error"; output: string };

// Probes the merge with `git merge-tree --write-tree`, which runs the 3-way
// merge entirely in memory: the repo's working tree and index are never
// touched, so a conflict found here can't leave the base branch mid-merge.
// Exit 0 = clean, 1 = conflicts, anything else = merge-tree itself failed.
async function probeMerge(repoDir: string, baseBranch: string, branchName: string): Promise<MergeProbe> {
  const proc = Bun.spawn(["git", "merge-tree", "--write-tree", "--name-only", baseBranch, branchName], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
    env: cleanGitEnv(),
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  if (exitCode === 0) return { status: "clean" };
  const output = [stdout, stderr].filter((s) => s.trim() !== "").join("\n");
  if (exitCode !== 1) return { status: "error", output };
  // On conflict the first stdout line is the resulting tree's OID; the
  // conflicted paths follow until the blank line that precedes the messages.
  const afterOid = stdout.split("\n").slice(1);
  const blankAt = afterOid.indexOf("");
  const files = (blankAt === -1 ? afterOid : afterOid.slice(0, blankAt)).filter((line) => line !== "");
  return { status: "conflict", files, output };
}

function sessionBranchName(meta: SessionMeta): string {
  // Pre-branchName-field sessions fell back to the legacy worqload/<shortId>
  // naming. Keep that path so we can still merge / push their branches.
  return meta.branchName || `worqload/${meta.id.slice(0, 8)}`;
}

function defaultPrTitle(meta: SessionMeta): string {
  if (meta.title && meta.title.trim() !== "") return meta.title.trim();
  const firstLine = meta.prompt.split("\n")[0] ?? meta.prompt;
  return firstLine.slice(0, 80);
}

export const syncBaseFromRemoteAction: Action = {
  id: "sync-base-from-remote",
  label: "Sync base from remote",
  description: "Pull the latest commits for the base branch from origin into the main repo's local base branch.",
  confirmMessage:
    "Fetch origin and fast-forward the local base branch to match it.\n\nIf the main repo has the base branch checked out it must be clean. If it isn't checked out (you're on some other branch), the local ref is updated directly. Non-fast-forward updates are refused.",
  group: "sync-base",
  async run({ meta, repoDir }) {
    const repoBranch = await gitCurrentBranch(repoDir);
    if (repoBranch === meta.baseBranch) {
      if (await isWorktreeDirty(repoDir)) {
        return fail("main repo has uncommitted changes; commit or stash them before syncing the base branch");
      }
      return runCommand(["git", "pull", "--ff-only", "origin", meta.baseBranch], repoDir);
    }
    return runCommand(["git", "fetch", "origin", `${meta.baseBranch}:${meta.baseBranch}`], repoDir);
  },
};

export const mergeToBaseAction: Action = {
  id: "merge-to-base",
  label: "Merge into base branch",
  description: "Merge this session's branch into the base branch in the main repo.",
  group: "ship",
  confirmMessage:
    "Merge this session's branch into the base branch?\n\nThe main repo must have the base branch checked out with a clean working tree, and the session worktree itself must have no uncommitted changes. If the merge would conflict, it is aborted before it touches the base branch.",
  async run({ meta, repoDir }) {
    if (await isWorktreeDirty(meta.worktreePath)) {
      return fail("session worktree has uncommitted changes; the agent must commit them before merging");
    }
    const repoBranch = await gitCurrentBranch(repoDir);
    if (repoBranch !== meta.baseBranch) {
      return fail(
        `main repo HEAD is on '${repoBranch}', not the base branch '${meta.baseBranch}'. Check out '${meta.baseBranch}' in the main repo and retry.`,
      );
    }
    if (await isWorktreeDirty(repoDir)) {
      return fail("main repo has uncommitted changes; commit or stash them in the main repo before merging");
    }
    const branchName = sessionBranchName(meta);
    // Refuse a conflicting merge before `git merge` runs: otherwise it would
    // leave the base branch mid-merge in the main repo, forcing conflict
    // resolution there instead of on the session branch.
    const probe = await probeMerge(repoDir, meta.baseBranch, branchName);
    if (probe.status === "error") {
      return { ok: false, exitCode: -1, stdout: probe.output, stderr: "", message: "could not pre-check the merge for conflicts; the merge was not attempted" };
    }
    if (probe.status === "conflict") {
      const where = probe.files.length > 0 ? `: ${probe.files.join(", ")}` : "";
      return {
        ok: false,
        exitCode: -1,
        stdout: probe.output,
        stderr: "",
        message: `merging '${branchName}' into '${meta.baseBranch}' would conflict${where}. The merge was not performed; resolve the conflict on the session branch (e.g. merge '${meta.baseBranch}' into it) and retry.`,
      };
    }
    const title = defaultPrTitle(meta);
    const message = `Merge session ${meta.id.slice(0, 8)}: ${title}`;
    return runCommand(["git", "merge", "--no-ff", "-m", message, branchName], repoDir);
  },
};

export const createPrAction: Action = {
  id: "create-pr",
  label: "Create PR",
  description: "Push the session branch to origin and create a pull request via the gh CLI.",
  group: "ship",
  confirmMessage:
    "Push this session's branch to origin and open a pull request with the gh CLI. Any uncommitted changes left in the session worktree are committed first, under the PR title.",
  params: [
    { name: "title", label: "Title", type: "string", placeholder: "(default: session title)" },
    { name: "body", label: "Body", type: "text", placeholder: "Optional PR body (markdown)" },
  ],
  async run({ meta, repoDir }, params) {
    const branchName = sessionBranchName(meta);
    const title = (params.title?.trim() || defaultPrTitle(meta)).trim();
    const body = params.body ?? "";
    if (title === "") return fail("title resolved to empty string");

    // The branch can't be pushed while work sits uncommitted. Rather than
    // refuse — the agent has often already stopped, so it can't be told to
    // commit — stage and commit it here under the PR title. `git add -A`
    // skips the .worqload-reports symlink on a repo that gitignored it; we
    // unstage it explicitly to cover repos that didn't, so it never lands in
    // the PR.
    const commitLog: string[] = [];
    if (await isWorktreeDirty(meta.worktreePath)) {
      const add = await runCommand(["git", "add", "-A"], meta.worktreePath);
      if (!add.ok) {
        return { ...add, message: "git add failed in the session worktree; nothing was committed or pushed" };
      }
      for (const entry of HIDDEN_WORKTREE_ENTRIES) {
        await runCommand(["git", "reset", "-q", "--", entry], meta.worktreePath);
      }
      const commit = await runCommand(["git", "commit", "-m", title], meta.worktreePath);
      if (!commit.ok) {
        return { ...commit, message: "git commit failed in the session worktree; nothing was pushed" };
      }
      commitLog.push(`$ git commit -m ${JSON.stringify(title)}\n${commit.stdout}`);
    }

    const push = await runCommand(["git", "push", "-u", "origin", branchName], repoDir);
    if (!push.ok) {
      return {
        ...push,
        stdout: [...commitLog, `$ git push -u origin ${branchName}\n${push.stdout}`].join("\n"),
        message: "git push failed before gh pr create was attempted",
      };
    }
    const gh = await runCommand(
      ["gh", "pr", "create", "--base", meta.baseBranch, "--head", branchName, "--title", title, "--body", body],
      repoDir,
    );
    return {
      ok: gh.ok,
      exitCode: gh.exitCode,
      stdout: [
        ...commitLog,
        `$ git push -u origin ${branchName}\n${push.stdout}`,
        `$ gh pr create --base ${meta.baseBranch} --head ${branchName}\n${gh.stdout}`,
      ].join("\n"),
      stderr: [push.stderr, gh.stderr].filter((s) => s.trim() !== "").join("\n"),
    };
  },
};

// --- preview: run a session's branch in a live worqload server ----------------

// A worqload checkout that carries the preview command — the only kind of
// session worktree the preview/stop-preview actions apply to.
function isWorqloadCheckout(dir: string): boolean {
  return existsSync(join(dir, "src", "commands", "preview.ts")) && existsSync(join(dir, "preview-seed"));
}

// Stable per-session port so the preview URL doesn't drift between runs; a
// 200-wide range keeps collisions rare, and `worqload preview` auto-shifts off
// a busy port anyway (the action reports the URL it actually bound).
export function previewPortForSession(sessionId: string): number {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) hash = (Math.imul(hash, 31) + sessionId.charCodeAt(i)) >>> 0;
  return 3500 + (hash % 200);
}

export function parsePreviewListeningUrl(logText: string): string | null {
  const match = logText.match(/listening on (\S+)/);
  return match ? match[1] : null;
}

function previewRoot(): string {
  const override = process.env.WORQLOAD_PREVIEW_DIR?.trim();
  return override && override !== "" ? override : join(homedir(), ".worqload-preview");
}

function previewPaths(meta: SessionMeta): { scratchRepo: string; logPath: string; pidPath: string } {
  const shortId = meta.id.slice(0, 8);
  const root = previewRoot();
  const scratchRepo = join(root, shortId);
  return { scratchRepo, logPath: join(root, `${shortId}.log`), pidPath: join(scratchRepo, ".worqload", "preview.pid") };
}

function readPreviewPid(pidPath: string): number | null {
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// SIGTERMs a previously-started preview server (if any) and waits for it to
// exit, so a follow-up `worqload preview --reset` doesn't rm its scratch repo
// out from under it. Returns the pid it stopped, or null if none was running.
async function stopPreviewProcess(pidPath: string): Promise<number | null> {
  const pid = readPreviewPid(pidPath);
  if (pid === null) return null;
  if (!processAlive(pid)) {
    try { unlinkSync(pidPath); } catch { /* already gone */ }
    return null;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* race: already exiting */ }
  for (let i = 0; i < 30 && processAlive(pid); i++) await Bun.sleep(100);
  try { unlinkSync(pidPath); } catch { /* the exiting process likely removed it */ }
  return pid;
}

async function waitForPreviewUrl(logPath: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const url = parsePreviewListeningUrl(readFileSync(logPath, "utf8"));
      if (url) return url;
    } catch { /* log not written yet */ }
    await Bun.sleep(200);
  }
  return null;
}

function tailFile(path: string, maxChars = 4000): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
  } catch {
    return "";
  }
}

export const previewAction: Action = {
  id: "preview",
  label: "Preview",
  group: "preview",
  description:
    "Start a worqload server running this session's branch against a throwaway repo under ~/.worqload-preview/<id> (recreated each run). It keeps running until you press \"Stop preview\"; `bun install` runs in the worktree first if it has no node_modules.",
  direct: true,
  availableFor: ({ meta }) => isWorqloadCheckout(meta.worktreePath),
  async run({ meta }) {
    const worktree = meta.worktreePath;
    if (!isWorqloadCheckout(worktree)) {
      return fail("this session's worktree is not a worqload checkout with the preview command");
    }
    const { scratchRepo, logPath, pidPath } = previewPaths(meta);
    const port = previewPortForSession(meta.id);

    // A preview is already running for this session: open it instead of
    // restarting. The pidfile is written by `worqload preview` on boot and
    // unlinked on exit; if it's stale (process dead) we fall through to the
    // restart flow below.
    const existingPid = readPreviewPid(pidPath);
    if (existingPid !== null && processAlive(existingPid)) {
      const existingUrl = parsePreviewListeningUrl(tailFile(logPath));
      if (existingUrl) {
        return {
          ok: true,
          exitCode: 0,
          stdout: `preview server (pid ${existingPid}) already listening on ${existingUrl}\nscratch repo: ${scratchRepo}\nlog: ${logPath}`,
          stderr: "",
          message: `Preview already running — open ${existingUrl}`,
        };
      }
    }

    if (!existsSync(join(worktree, "node_modules"))) {
      const install = await runCommand(["bun", "install"], worktree);
      if (!install.ok) return { ...install, message: "`bun install` failed in the session worktree; the preview server was not started" };
    }
    // Drop the prior frontend build so `worqload preview` rebuilds web/dist
    // from this branch's sources rather than serving a stale bundle.
    try { rmSync(join(worktree, "web", "dist"), { recursive: true, force: true }); } catch { /* nothing to drop */ }

    const stoppedPid = await stopPreviewProcess(pidPath);
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, "w");
    const proc = Bun.spawn([process.execPath, join(worktree, "src", "cli.ts"), "preview", String(port), "--no-open", "--reset"], {
      cwd: worktree,
      env: { ...process.env, WORQLOAD_PREVIEW_REPO: scratchRepo },
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
    });
    try { closeSync(logFd); } catch { /* spawn may have taken ownership */ }
    proc.unref();

    const restarted = stoppedPid !== null ? ` (restarted; stopped previous pid ${stoppedPid})` : "";
    const url = await waitForPreviewUrl(logPath, 12_000);
    if (!url) {
      return {
        ok: false,
        exitCode: -1,
        stdout: tailFile(logPath),
        stderr: "",
        message: `preview server did not report a listening URL within 12s${restarted}. Log: ${logPath}`,
      };
    }
    return {
      ok: true,
      exitCode: 0,
      stdout: `preview server (pid ${proc.pid}) listening on ${url}${restarted}\nscratch repo: ${scratchRepo}\nlog: ${logPath}`,
      stderr: "",
      message: `Preview ready — open ${url}`,
    };
  },
};

export const stopPreviewAction: Action = {
  id: "stop-preview",
  label: "Stop preview",
  description: "Stop the preview server started for this session.",
  group: "preview",
  direct: true,
  availableFor: ({ meta }) => isWorqloadCheckout(meta.worktreePath),
  async run({ meta }) {
    const { pidPath } = previewPaths(meta);
    const pid = readPreviewPid(pidPath);
    if (pid === null) {
      return { ok: true, exitCode: 0, stdout: "", stderr: "", message: "no preview server is running for this session" };
    }
    if (!processAlive(pid)) {
      try { unlinkSync(pidPath); } catch { /* already gone */ }
      return { ok: true, exitCode: 0, stdout: "", stderr: "", message: `preview server (pid ${pid}) was not running; cleaned up` };
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      return fail(`failed to signal preview server (pid ${pid}): ${err instanceof Error ? err.message : String(err)}`);
    }
    for (let i = 0; i < 20 && processAlive(pid); i++) await Bun.sleep(100);
    try { unlinkSync(pidPath); } catch { /* the exiting process likely removed it */ }
    return { ok: true, exitCode: 0, stdout: `sent SIGTERM to preview server (pid ${pid})`, stderr: "", message: "preview server stopped" };
  },
};

const ACTIONS: Action[] = [syncBaseFromRemoteAction, mergeToBaseAction, createPrAction, previewAction, stopPreviewAction];

function toDescriptor({ run: _run, availableFor: _availableFor, ...rest }: Action): ActionDescriptor {
  return rest;
}

export function listActions(): ActionDescriptor[] {
  return ACTIONS.map(toDescriptor);
}

// Actions to offer for a particular session: drops any whose availableFor
// predicate rejects this session's context.
export function listAvailableActions(ctx: ActionContext): ActionDescriptor[] {
  return ACTIONS.filter((a) => !a.availableFor || a.availableFor(ctx)).map(toDescriptor);
}

export function findAction(id: string): Action | undefined {
  return ACTIONS.find((a) => a.id === id);
}
