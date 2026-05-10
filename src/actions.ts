import type { SessionMeta } from "./session";

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
  params?: ActionParamSpec[];
  run(ctx: ActionContext, params: Record<string, string>): Promise<ActionResult>;
}

export interface ActionDescriptor {
  id: string;
  label: string;
  description?: string;
  confirmMessage?: string;
  params?: ActionParamSpec[];
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
// the case where the agent edited but forgot to commit. Users are expected to
// gitignore .worqload/ and .worqload-reports per the deployment guide.
async function isWorktreeDirty(cwd: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "pipe", env: cleanGitEnv() });
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

function sessionBranchName(meta: SessionMeta): string {
  return `worqload/${meta.id.slice(0, 8)}`;
}

function defaultPrTitle(meta: SessionMeta): string {
  if (meta.title && meta.title.trim() !== "") return meta.title.trim();
  const firstLine = meta.prompt.split("\n")[0] ?? meta.prompt;
  return firstLine.slice(0, 80);
}

export const mergeToBaseAction: Action = {
  id: "merge-to-base",
  label: "Merge into base branch",
  description: "Merge this session's branch into the base branch in the main repo.",
  confirmMessage:
    "Merge this session's branch into the base branch?\n\nThe main repo must have the base branch checked out with a clean working tree, and the session worktree itself must have no uncommitted changes.",
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
    const title = defaultPrTitle(meta);
    const message = `Merge worqload session ${meta.id.slice(0, 8)}: ${title}`;
    return runCommand(["git", "merge", "--no-ff", "-m", message, branchName], repoDir);
  },
};

export const createPrAction: Action = {
  id: "create-pr",
  label: "Create PR",
  description: "Push the session branch to origin and create a pull request via the gh CLI.",
  params: [
    { name: "title", label: "Title", type: "string", placeholder: "(default: session title)" },
    { name: "body", label: "Body", type: "text", placeholder: "Optional PR body (markdown)" },
  ],
  async run({ meta, repoDir }, params) {
    if (await isWorktreeDirty(meta.worktreePath)) {
      return fail("session worktree has uncommitted changes; the agent must commit them before pushing");
    }
    const branchName = sessionBranchName(meta);
    const title = (params.title?.trim() || defaultPrTitle(meta)).trim();
    const body = params.body ?? "";
    if (title === "") return fail("title resolved to empty string");

    const push = await runCommand(["git", "push", "-u", "origin", branchName], repoDir);
    if (!push.ok) {
      return {
        ...push,
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
      stdout: `$ git push -u origin ${branchName}\n${push.stdout}\n$ gh pr create --base ${meta.baseBranch} --head ${branchName}\n${gh.stdout}`,
      stderr: [push.stderr, gh.stderr].filter((s) => s.trim() !== "").join("\n"),
    };
  },
};

const ACTIONS: Action[] = [mergeToBaseAction, createPrAction];

export function listActions(): ActionDescriptor[] {
  return ACTIONS.map(({ run: _run, ...rest }) => rest);
}

export function findAction(id: string): Action | undefined {
  return ACTIONS.find((a) => a.id === id);
}
