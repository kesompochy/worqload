// The "PR link" extension: given a session's branch, resolve the URL of the
// pull request that tracks it on the remote, if one exists.
//
// worqload core couples to git only through `WorktreeOps`; it must not learn
// about `gh` the way it learned about `git`. So the PR lookup lives behind
// `PrLinkResolver`, injected into the server like `worktreeOps` /
// `reportRewriter`. `ghPrLinkResolver` — the one official implementation — is
// the *only* place that knows the lookup is done with the `gh` CLI; swapping it
// for a GitHub-API or a forge-specific resolver never touches the server.

export type PrLinkReason = "no-pr" | "gh-missing" | "gh-error";

export type PrLinkResult = { url: string } | { url: null; reason: PrLinkReason };

export interface PrLinkResolver {
  // worktreePath is where the lookup runs (a git worktree of the repo, so the
  // remote it queries is the session repo's remote). branchName is the session
  // branch whose tracking PR we want.
  resolve(params: { worktreePath: string; branchName: string }): Promise<PrLinkResult>;
}

function cleanGitEnv(): Record<string, string | undefined> {
  return { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };
}

// Maps a `gh pr list … --json url` invocation's outcome to a PrLinkResult. Kept
// pure (no spawning) so the result mapping is unit-testable without `gh` on
// PATH or a network. `spawned` is false when the gh binary itself could not be
// launched (not installed); a non-zero exit covers the cases where gh ran but
// could not answer (not authenticated, no GitHub remote, repo not found).
export function interpretGhPrList(outcome: { spawned: boolean; exitCode: number; stdout: string }): PrLinkResult {
  if (!outcome.spawned) return { url: null, reason: "gh-missing" };
  if (outcome.exitCode !== 0) return { url: null, reason: "gh-error" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    return { url: null, reason: "gh-error" };
  }
  if (!Array.isArray(parsed)) return { url: null, reason: "gh-error" };
  const first = parsed[0] as { url?: unknown } | undefined;
  if (first && typeof first.url === "string" && first.url !== "") {
    return { url: first.url };
  }
  return { url: null, reason: "no-pr" };
}

// `gh pr list --head <branch>` queries the remote by head-branch name without
// needing the branch checked out or pushed locally — the right primitive here,
// since worqload leaves push/merge to the human and the session branch is
// usually neither the main repo's HEAD nor yet on the remote under its own
// ref. `--state all` so a branch whose PR was already merged/closed still
// links. `--limit 1` + `[0]` takes the most recent if several share the head.
export const ghPrLinkResolver: PrLinkResolver = {
  async resolve({ worktreePath, branchName }) {
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(["gh", "pr", "list", "--head", branchName, "--state", "all", "--json", "url", "--limit", "1"], {
        cwd: worktreePath,
        stdout: "pipe",
        stderr: "pipe",
        env: cleanGitEnv(),
      });
    } catch {
      return { url: null, reason: "gh-missing" };
    }
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return interpretGhPrList({ spawned: true, exitCode, stdout });
  },
};
