import type { Subprocess } from "bun";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendEvent } from "./event-log";
import { realWorktreeOps, type WorktreeOps } from "./worktree";
import type { HostClient } from "./session-host-client";
import type { HostLauncher } from "./web-server";

interface Stoppable {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

const tmpDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

export function makeTmpDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `worqload-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

// Building a git repo from scratch is ~6 `git` process spawns (~200ms on
// macOS); tests create dozens. Build each distinct layout once into a template
// that survives the suite, then hand out copies (a directory tree copy is an
// order of magnitude cheaper than re-running git). Template dirs are not
// tracked for per-test cleanup on purpose — they must outlive afterEach — and
// are small enough to leave for the OS tmp reaper.
const repoTemplates = new Map<string, string>();

export function makeRepoFromTemplate(key: string, build: (dir: string) => void): string {
  let template = repoTemplates.get(key);
  if (!template) {
    template = mkdtempSync(join(tmpdir(), "worqload-repo-template-"));
    build(template);
    repoTemplates.set(key, template);
  }
  const dir = makeTmpDir("repo");
  cpSync(template, dir, { recursive: true });
  return dir;
}

export function trackTmpDir(dir: string): void {
  tmpDirs.push(dir);
}

export function trackCleanup(fn: () => Promise<void>): void {
  cleanups.push(fn);
}

const KILL_GRACE_MS = 200;

async function killProcessGracefully(p: Subprocess): Promise<void> {
  if (p.exitCode !== null) return;
  try { p.kill("SIGTERM"); } catch { /* already dead */ }
  const timer = new Promise<"timeout">(r => setTimeout(() => r("timeout"), KILL_GRACE_MS));
  const result = await Promise.race([p.exited, timer]);
  if (result === "timeout") {
    try { p.kill("SIGKILL"); } catch {}
    await p.exited.catch(() => {});
  }
}

export function trackSubprocess<T extends Subprocess>(p: T): T {
  trackCleanup(() => killProcessGracefully(p));
  return p;
}

export function trackServer<T extends Stoppable>(s: T): T {
  trackCleanup(async () => { try { await s.stop(true); } catch {} });
  return s;
}

// An fs-only stand-in for the git/worktree layer (`startServer({ worktreeOps })`).
// A "worktree" is just a directory under <repo>/.worktrees/<shortId>; base
// commit / current branch return fixed values; diffs return a recognisable
// canned string. File listing and reading are real fs operations — no git is
// involved there — so endpoints that surface worktree contents stay faithful.
// Lets server tests run without `git init` / `git commit` / `git worktree add`.
export function fakeWorktreeOps(): WorktreeOps {
  return {
    async createSessionWorktree({ sessionId, repoDir, branchName, reportsDirAbsolute }) {
      const worktreePath = join(repoDir, ".worktrees", sessionId.slice(0, 8));
      mkdirSync(worktreePath, { recursive: true });
      mkdirSync(reportsDirAbsolute, { recursive: true });
      const link = join(worktreePath, ".worqload-reports");
      if (!existsSync(link)) symlinkSync(reportsDirAbsolute, link);
      return { worktreePath, branchName };
    },
    async removeWorktree(worktreePath) {
      try { unlinkSync(join(worktreePath, ".worqload-reports")); } catch { /* already gone */ }
      rmSync(worktreePath, { recursive: true, force: true });
    },
    async resolveBaseCommit() { return "0".repeat(40); },
    async currentBranch() { return "trunk"; },
    async resolveDiffBase(_worktreePath, _baseBranch, baseCommit) { return baseCommit; },
    async gitDiff(_worktreePath, target) { return `--- diff against ${target} ---\n`; },
    async listWorktreeFiles(worktreePath) {
      if (!existsSync(worktreePath)) return [];
      const found: string[] = [];
      const walk = (dir: string, prefix: string): void => {
        for (const name of readdirSync(dir)) {
          if (name === ".worqload-reports" || name === ".git") continue;
          const abs = join(dir, name);
          const rel = prefix ? `${prefix}/${name}` : name;
          if (statSync(abs).isDirectory()) walk(abs, rel);
          else found.push(rel);
        }
      };
      walk(worktreePath, "");
      return found.sort();
    },
    // Reading a single file is pure fs (path-escape checks, binary sniff, size
    // limit) with no git, so the production implementation is the fake too.
    readWorktreeFile: realWorktreeOps.readWorktreeFile,
    // The fake worktree isn't a git repo, so a revision-scoped tree query has
    // nothing to return. Server endpoints that ask for the Before snapshot get
    // back an empty file list / not-found, which is the same shape the real
    // implementation produces for a missing `rev`.
    async listFilesAtRevision() { return []; },
    async readFileAtRevision() { return { kind: "not-found" }; },
    async gitRemoteUrl() { return "git@github.com:owner/repo.git"; },
    async gitHeadSha() { return "f".repeat(40); },
  };
}

// In-memory stand-in for a session host (`startServer({ hostLauncher })`):
// writes the session_started / session_resumed event the real host writes on
// attach, then behaves as an idle host whose claude process exits on
// kill/close. Lets server tests create sessions without spawning the host (and
// its claude child) as subprocesses.
export function inProcessHostLauncher(): HostLauncher {
  return async ({ meta, sessionsDir, resume, onEvent }) => {
    const event = await appendEvent(
      meta.id,
      { kind: resume ? "session_resumed" : "session_started", payload: { prompt: meta.prompt } },
      sessionsDir,
    );
    onEvent(event);
    let resolveExited!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => { resolveExited = r; });
    const client: HostClient = {
      async send() {},
      async kill() { resolveExited(null); },
      async close() { resolveExited(null); },
      replayCompleted: Promise.resolve({ lastSeq: event.seq }),
      exited,
    };
    return { client };
  };
}

export async function cleanupAll(): Promise<void> {
  // Run cleanups in reverse order so dependent resources unwind correctly
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      try { await fn(); } catch {}
    }
  }
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
}
