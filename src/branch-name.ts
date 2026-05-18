// Branch name resolution for session worktrees.
//
// In order of preference at session creation time:
//   1. user-supplied name (if non-empty and passes sanitizeBranchName)
//   2. claude-generated short name based on the prompt
//   3. <shortId> only (8 hex chars from sessionId) as fallback
//
// sanitizeBranchName enforces a conservative subset of git ref names so an LLM
// or human typo cannot produce a name that breaks `git worktree add -b`.

import { randomUUID } from "node:crypto";
import CLAUDE_INSTRUCTION from "./prompts/branch-name-instruction.txt" with { type: "text" };
import { defaultTmuxDeps, tmuxOneShotText, type TmuxDriverDeps } from "./session-driver-tmux";

const MAX_LEN = 60;

// rules: a leading char that is not '-' or '/', followed by allowed chars
// (alphanumeric, '.', '_', '-', '/'). We further filter for forbidden
// sequences below.
const ALLOWED_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_./-]*$/;
const FORBIDDEN_SUBSTRINGS = ["..", "//", "@{", "~", "^", ":", "?", "*", "[", "\\"];

export function sanitizeBranchName(input: string): string | null {
  // Take the first whitespace-separated token from the trimmed input so a
  // chatty LLM ("the branch name is fix-bug") doesn't break us.
  const firstToken = input.trim().split(/\s+/)[0] ?? "";
  if (firstToken === "") return null;
  if (firstToken.length > MAX_LEN) return null;
  if (!ALLOWED_RE.test(firstToken)) return null;
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    if (firstToken.includes(forbidden)) return null;
  }
  if (firstToken.endsWith(".lock")) return null;
  if (firstToken.endsWith("/") || firstToken.endsWith(".")) return null;
  return firstToken;
}

export type BranchNameGenerator = (prompt: string) => Promise<string | null>;

// The branch-name agent is the same `claude` the sessions run, so it honors the
// same WORQLOAD_SPAWN_COMMAND override serve.ts uses to point at a relocated or
// renamed claude binary. Only the executable (first whitespace token) is taken:
// this is a plain `-p <prompt>` text query, not the stream-json session
// invocation, so the spawn command's session flags do not apply here.
export function resolveBranchNameClaudeBin(env: Record<string, string | undefined> = process.env): string {
  const spawnEnv = env.WORQLOAD_SPAWN_COMMAND;
  if (spawnEnv && spawnEnv.trim() !== "") {
    const [executable] = spawnEnv.trim().split(/\s+/);
    if (executable) return executable;
  }
  return "claude";
}

async function pipeBranchName(fullPrompt: string): Promise<string | null> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([resolveBranchNameClaudeBin(), "-p", fullPrompt], { stdout: "pipe", stderr: "pipe" });
  } catch {
    return null;
  }
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  return sanitizeBranchName(out);
}

async function tmuxBranchName(fullPrompt: string, tmuxDeps: TmuxDriverDeps): Promise<string | null> {
  const text = await tmuxOneShotText(
    {
      prompt: fullPrompt,
      claudeBin: resolveBranchNameClaudeBin(),
      // Branch naming runs before the session worktree exists, so use serve's
      // cwd (the repo root). No worqload session env to forward.
      cwd: process.cwd(),
      // A fresh UUID so the pinned transcript filename / tmux session name
      // cannot collide with a real session sharing this cwd.
      sessionId: randomUUID(),
      env: {},
    },
    tmuxDeps,
  ).catch(() => null);
  return text === null ? null : sanitizeBranchName(text);
}

// Asks Claude for a short branch name. Returns null on any failure (claude not
// on PATH, non-zero exit, unparseable output, tmux teardown timeout) so the
// caller can fall back to <shortId>.
//
// WORQLOAD_DRIVER=tmux routes through interactive claude in tmux, the same
// route serve uses for sessions to avoid the `claude -p` Agent SDK credit
// pool; otherwise the pipe path runs `claude -p` directly. tmuxDeps is
// injectable for tests; production uses defaultTmuxDeps.
export function makeBranchNameGenerator(tmuxDeps: TmuxDriverDeps = defaultTmuxDeps): BranchNameGenerator {
  return async (prompt) => {
    const fullPrompt = `${CLAUDE_INSTRUCTION}\n\nTask: ${prompt}`;
    if ((process.env.WORQLOAD_DRIVER ?? "").trim() === "tmux") {
      return tmuxBranchName(fullPrompt, tmuxDeps);
    }
    return pipeBranchName(fullPrompt);
  };
}

export const defaultBranchNameGenerator: BranchNameGenerator = makeBranchNameGenerator();
