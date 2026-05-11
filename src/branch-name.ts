// Branch name resolution for session worktrees.
//
// In order of preference at session creation time:
//   1. user-supplied name (if non-empty and passes sanitizeBranchName)
//   2. claude-generated short name based on the prompt
//   3. <shortId> only (8 hex chars from sessionId) as fallback
//
// sanitizeBranchName enforces a conservative subset of git ref names so an LLM
// or human typo cannot produce a name that breaks `git worktree add -b`.

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

const CLAUDE_INSTRUCTION = [
  "Generate a short git branch name describing this task.",
  "Rules: kebab-case, 1-3 hyphenated lowercase words, ASCII letters/digits/hyphens only, max 30 chars.",
  "Output ONLY the branch name on a single line. No explanation, no quotes.",
].join(" ");

// Default generator: spawn `claude -p` to ask Claude for a short branch name.
// Returns null on any failure (claude not on PATH, non-zero exit, unparseable
// output) so the caller can fall back to <shortId>.
export const defaultBranchNameGenerator: BranchNameGenerator = async (prompt) => {
  const fullPrompt = `${CLAUDE_INSTRUCTION}\n\nTask: ${prompt}`;
  let proc;
  try {
    proc = Bun.spawn(["claude", "-p", fullPrompt], { stdout: "pipe", stderr: "pipe" });
  } catch {
    return null;
  }
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  return sanitizeBranchName(out);
};
