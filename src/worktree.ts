import { join, resolve, sep } from "path";
import { existsSync, symlinkSync, unlinkSync, realpathSync, statSync } from "fs";
import { mkdir } from "node:fs/promises";

function cleanGitEnv(): Record<string, string | undefined> {
  return { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };
}

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
}

export async function createSessionWorktree(params: {
  sessionId: string;
  repoDir: string;
  baseBranch: string;
  branchName: string;
  reportsDirAbsolute: string;
}): Promise<WorktreeInfo> {
  const { sessionId, repoDir, baseBranch, branchName, reportsDirAbsolute } = params;
  const shortId = sessionId.slice(0, 8);
  const worktreePath = join(resolve(repoDir), ".worktrees", shortId);

  await mkdir(reportsDirAbsolute, { recursive: true });

  const proc = Bun.spawn(
    ["git", "worktree", "add", "-b", branchName, worktreePath, baseBranch],
    { stdout: "pipe", stderr: "pipe", cwd: repoDir, env: cleanGitEnv() },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to create worktree: ${stderr.trim()}`);
  }

  // symlink so the agent can read its own reports via .worqload-reports/<file>
  const symlinkPath = join(worktreePath, ".worqload-reports");
  if (!existsSync(symlinkPath)) {
    symlinkSync(reportsDirAbsolute, symlinkPath);
  }

  // session-private scratch for report/escalation drafts. The agent is told
  // (in the session bootstrap) to Write its draft here and Read it back as the
  // "推敲" step before submitting. We pre-create it so the path is well-defined
  // from the agent's first turn; HIDDEN_WORKTREE_ENTRIES keeps it out of the
  // explorer, the dirty-check, and the create-PR auto-commit.
  await mkdir(join(worktreePath, ".worqload-draft"), { recursive: true });

  return { worktreePath, branchName };
}

export async function removeWorktree(
  worktreePath: string,
  branchName?: string,
  repoDir?: string,
): Promise<void> {
  const env = cleanGitEnv();

  const symlinkPath = join(worktreePath, ".worqload-reports");
  try { unlinkSync(symlinkPath); } catch { /* already gone */ }

  const removeProc = Bun.spawn(
    ["git", "worktree", "remove", "--force", worktreePath],
    { stdout: "pipe", stderr: "pipe", env, ...(repoDir ? { cwd: repoDir } : {}) },
  );
  await removeProc.exited;

  if (branchName) {
    const branchProc = Bun.spawn(
      ["git", "branch", "-D", branchName],
      { stdout: "pipe", stderr: "pipe", env, ...(repoDir ? { cwd: repoDir } : {}) },
    );
    await branchProc.exited;
  }
}

export async function resolveBaseCommit(
  baseBranch: string,
  repoDir: string,
): Promise<string> {
  const proc = Bun.spawn(
    ["git", "rev-parse", baseBranch],
    { stdout: "pipe", stderr: "pipe", cwd: repoDir, env: cleanGitEnv() },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`Failed to resolve ${baseBranch}: ${err.trim()}`);
  }
  return out.trim();
}

// The push URL of `origin`, or the first remote if there's no `origin`, or null
// if the worktree has no remotes. Used only to build "open this on GitHub"
// permalinks — no fetch, just a config read.
export async function gitRemoteUrl(worktreePath: string): Promise<string | null> {
  const url = await gitOutput(worktreePath, ["remote", "get-url", "origin"]);
  if (url !== null) return url;
  const remotes = await gitOutput(worktreePath, ["remote"]);
  const first = remotes?.split("\n").map(r => r.trim()).find(r => r !== "");
  if (!first) return null;
  return gitOutput(worktreePath, ["remote", "get-url", first]);
}

export async function gitHeadSha(worktreePath: string): Promise<string | null> {
  return gitOutput(worktreePath, ["rev-parse", "HEAD"]);
}

async function gitOutput(worktreePath: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(
    ["git", ...args],
    { stdout: "pipe", stderr: "pipe", cwd: worktreePath, env: cleanGitEnv() },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return null;
  const trimmed = out.trim();
  return trimmed === "" ? null : trimmed;
}

export async function currentBranch(repoDir: string): Promise<string> {
  const proc = Bun.spawn(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    { stdout: "pipe", stderr: "pipe", cwd: repoDir, env: cleanGitEnv() },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error("Failed to detect current branch");
  }
  return out.trim();
}

// worqload injects two entries at the worktree root: the `.worqload-reports`
// symlink (points into .worqload/ so the agent can read its own reports) and
// the `.worqload-draft/` directory (session-private scratch where the agent
// drafts reports before submitting them). Neither is project content. Keep
// both out of the explorer, the uncommitted-changes check, and the create-PR
// auto-commit, even when the user hasn't gitignored them.
export const HIDDEN_WORKTREE_ENTRIES = new Set([".worqload-reports", ".worqload-draft"]);

// True for the hidden entries themselves and for anything beneath them. The
// explorer filter compares against worktree-relative file paths, so for a
// directory entry like `.worqload-draft` we have to recognize its children too.
export function isHiddenWorktreeEntry(relPath: string): boolean {
  if (HIDDEN_WORKTREE_ENTRIES.has(relPath)) return true;
  for (const entry of HIDDEN_WORKTREE_ENTRIES) {
    if (relPath.startsWith(entry + "/")) return true;
  }
  return false;
}

// Files the agent can inspect in a session worktree: everything git tracks plus
// new untracked files, minus anything .gitignore (and friends) excludes — so
// build artefacts and node_modules don't drown the explorer, but a file the
// agent just created is still visible.
export async function listWorktreeFiles(worktreePath: string): Promise<string[]> {
  if (!existsSync(worktreePath)) return [];
  const proc = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { stdout: "pipe", stderr: "pipe", cwd: worktreePath, env: cleanGitEnv() },
  );
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ls-files failed: ${err.trim()}`);
  }
  return out.split("\0").filter(p => p !== "" && !isHiddenWorktreeEntry(p)).sort();
}

// 2 MiB: large enough for any source file worth reading in a browser, small
// enough that we never stream a checked-in binary or dataset by accident.
const MAX_VIEWABLE_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

export type WorktreeFileContent =
  | { kind: "text"; content: string }
  | { kind: "binary" }
  | { kind: "too-large"; size: number }
  | { kind: "not-found" }
  | { kind: "not-a-file" }
  | { kind: "denied" };

// Reads a single file from inside the worktree. relPath is worktree-relative;
// anything that resolves (lexically or through symlinks) outside the worktree
// is refused so a crafted ?path= can't read arbitrary disk.
export async function readWorktreeFile(
  worktreePath: string,
  relPath: string,
): Promise<WorktreeFileContent> {
  const root = resolve(worktreePath);
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) return { kind: "denied" };

  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(abs);
    realRoot = realpathSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "not-found" };
    throw err;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { kind: "denied" };

  const stat = statSync(real);
  if (!stat.isFile()) return { kind: "not-a-file" };
  if (stat.size > MAX_VIEWABLE_FILE_BYTES) return { kind: "too-large", size: stat.size };

  const bytes = await Bun.file(real).bytes();
  const sniffLen = Math.min(bytes.byteLength, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniffLen; i++) {
    if (bytes[i] === 0) return { kind: "binary" };
  }
  return { kind: "text", content: new TextDecoder().decode(bytes) };
}

export interface FileSearchMatch {
  path: string;   // worktree-relative
  line: number;   // 1-based line number of the match
  text: string;   // the matching line (truncated if very long)
}

// 200 matches is enough to find what you're after; beyond that the query is too
// broad to scroll through, so we stop and let the caller say "narrow it down".
const FILE_SEARCH_MATCH_LIMIT = 200;
// A single minified-bundle line can be hundreds of KB; clip it so the response
// stays small and the result row stays one line.
const FILE_SEARCH_LINE_MAX_CHARS = 240;

// Full-text search over the given worktree-relative files: case-insensitive
// substring match, reported line by line. Binary, too-large, and otherwise
// unreadable files are skipped (the same files the Files explorer can't show).
// Stops at FILE_SEARCH_MATCH_LIMIT matches and sets `truncated` so the caller
// can tell the human there are more.
export async function searchFileContents(
  worktreePath: string,
  relPaths: string[],
  query: string,
): Promise<{ matches: FileSearchMatch[]; truncated: boolean }> {
  const needle = query.toLowerCase();
  if (needle === "") return { matches: [], truncated: false };
  const matches: FileSearchMatch[] = [];
  for (const relPath of relPaths) {
    const file = await readWorktreeFile(worktreePath, relPath);
    if (file.kind !== "text") continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      const text = lines[i].length > FILE_SEARCH_LINE_MAX_CHARS
        ? lines[i].slice(0, FILE_SEARCH_LINE_MAX_CHARS) + "…"
        : lines[i];
      matches.push({ path: relPath, line: i + 1, text });
      if (matches.length >= FILE_SEARCH_MATCH_LIMIT) return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

// The Diff View shows the changes stacked on this branch — what a reviewer of
// this branch alone would see. The naive base is `baseCommit`, the base
// branch's tip recorded when the session forked. But once the human runs
// "update branch" (merges the base branch into this branch to pick up other
// sessions' work), `git diff <baseCommit>` also lists everything the base
// branch gained in the meantime. So we move the base forward to the merge-base
// of HEAD and the *current* base branch whenever that sits past `baseCommit`:
// after such a merge that merge-base is the absorbed tip, which drops the
// absorbed commits out of the diff. We never consult a remote-tracking ref —
// worqload leaves merge/push to the human, and a stale `origin/<base>` would
// only drag noise back in. If the base branch is gone or trails `baseCommit`
// (the local checkout never fetched), `baseCommit` stands.
export async function resolveDiffBase(
  worktreePath: string,
  baseBranch: string,
  baseCommit: string,
): Promise<string> {
  const mergeBase = await gitMergeBase(worktreePath, baseBranch, "HEAD");
  if (mergeBase && mergeBase !== baseCommit && await isAncestor(worktreePath, baseCommit, mergeBase)) {
    return mergeBase;
  }
  return baseCommit;
}

async function gitMergeBase(worktreePath: string, a: string, b: string): Promise<string | null> {
  const proc = Bun.spawn(
    ["git", "merge-base", a, b],
    { stdout: "pipe", stderr: "pipe", cwd: worktreePath, env: cleanGitEnv() },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return null;
  const sha = out.trim();
  return sha === "" ? null : sha;
}

async function isAncestor(worktreePath: string, ancestor: string, descendant: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["git", "merge-base", "--is-ancestor", ancestor, descendant],
    { stdout: "pipe", stderr: "pipe", cwd: worktreePath, env: cleanGitEnv() },
  );
  return (await proc.exited) === 0;
}

export async function gitDiff(
  worktreePath: string,
  target: string,
  contextLines?: number,
): Promise<string> {
  const args = ["git", "diff", "--no-color"];
  if (contextLines !== undefined) args.push(`-U${contextLines}`);
  args.push(target);
  const proc = Bun.spawn(
    args,
    { stdout: "pipe", stderr: "pipe", cwd: worktreePath, env: cleanGitEnv() },
  );
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git diff ${target} failed: ${err.trim()}`);
  }
  return out;
}

// The worktree/git operations the web server depends on, gathered behind one
// interface so tests can substitute an fs-only fake. The real binding lives in
// `realWorktreeOps`; only the two things worqload genuinely couples to git for —
// session worktrees and diffs — live here.
export interface WorktreeOps {
  createSessionWorktree(params: {
    sessionId: string;
    repoDir: string;
    baseBranch: string;
    branchName: string;
    reportsDirAbsolute: string;
  }): Promise<WorktreeInfo>;
  removeWorktree(worktreePath: string, branchName?: string, repoDir?: string): Promise<void>;
  resolveBaseCommit(baseBranch: string, repoDir: string): Promise<string>;
  currentBranch(repoDir: string): Promise<string>;
  resolveDiffBase(worktreePath: string, baseBranch: string, baseCommit: string): Promise<string>;
  gitDiff(worktreePath: string, target: string, contextLines?: number): Promise<string>;
  listWorktreeFiles(worktreePath: string): Promise<string[]>;
  readWorktreeFile(worktreePath: string, relPath: string): Promise<WorktreeFileContent>;
  gitRemoteUrl(worktreePath: string): Promise<string | null>;
  gitHeadSha(worktreePath: string): Promise<string | null>;
}

export const realWorktreeOps: WorktreeOps = {
  createSessionWorktree,
  removeWorktree,
  resolveBaseCommit,
  currentBranch,
  resolveDiffBase,
  gitDiff,
  listWorktreeFiles,
  readWorktreeFile,
  gitRemoteUrl,
  gitHeadSha,
};
