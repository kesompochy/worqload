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

export interface PrLinkResolveParams {
  // worktreePath is where the lookup runs (a git worktree of the repo, so the
  // remote it queries is the session repo's remote). branchName is the session
  // branch whose tracking PR we want.
  worktreePath: string;
  branchName: string;
  // Skip any memoization and resolve live. Set right after `create-pr` so the
  // freshly opened PR shows immediately instead of after the cache TTL.
  bypassCache?: boolean;
}

export interface PrLinkResolver {
  resolve(params: PrLinkResolveParams): Promise<PrLinkResult>;
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

// Default cache lifetime. PR existence for a branch changes rarely (open /
// merge / close are human actions), so a few minutes of staleness is fine —
// long enough that the 30s sidebar poll warming every session's link costs at
// most one `gh` per branch per window, short enough that an externally-opened
// PR still surfaces without a reload. The `create-pr` path doesn't wait it
// out: it passes bypassCache.
const DEFAULT_PR_LINK_TTL_MS = 5 * 60_000;

// Memoizes a resolver per (worktree, branch). The sidebar prefetches every
// session's PR link in the background off the session-list poll; without this
// each poll would spawn one `gh` per session, and — the actual complaint — the
// link would only appear a visible beat after a session was opened. With the
// cache warm, the value is already in hand when the human opens the session.
// A hit inside the TTL returns without touching the inner resolver; a miss,
// an expired entry, or bypassCache resolves live and refreshes the entry.
export function makeCachedPrLinkResolver(
  inner: PrLinkResolver,
  opts: { ttlMs?: number; now?: () => number } = {},
): PrLinkResolver {
  const ttlMs = opts.ttlMs ?? DEFAULT_PR_LINK_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { result: PrLinkResult; at: number }>();
  return {
    async resolve(params) {
      const key = `${params.worktreePath}\0${params.branchName}`;
      if (!params.bypassCache) {
        const hit = cache.get(key);
        if (hit && now() - hit.at < ttlMs) return hit.result;
      }
      const result = await inner.resolve(params);
      cache.set(key, { result, at: now() });
      return result;
    },
  };
}
