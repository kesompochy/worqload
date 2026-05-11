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

// worqload injects a `.worqload-reports` symlink at the worktree root; it points
// outside the worktree (into .worqload/) so it isn't browsable anyway, and it's
// not project content, so keep it out of the explorer even when the user hasn't
// gitignored it.
const HIDDEN_WORKTREE_ENTRIES = new Set([".worqload-reports"]);

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
  return out.split("\0").filter(p => p !== "" && !HIDDEN_WORKTREE_ENTRIES.has(p)).sort();
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
