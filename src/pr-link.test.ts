import { expect, test } from "bun:test";
import { interpretGhPrList, makeCachedPrLinkResolver, type PrLinkResolver } from "./pr-link";

function countingResolver(result: { url: string }): { resolver: PrLinkResolver; calls: () => number } {
  let calls = 0;
  return {
    resolver: {
      async resolve() {
        calls++;
        return result;
      },
    },
    calls: () => calls,
  };
}

test("interpretGhPrList returns the PR URL when gh lists one for the branch", () => {
  const stdout = JSON.stringify([{ url: "https://github.com/owner/repo/pull/42" }]);
  expect(interpretGhPrList({ spawned: true, exitCode: 0, stdout })).toEqual({
    url: "https://github.com/owner/repo/pull/42",
  });
});

test("interpretGhPrList returns no-pr when gh runs but lists nothing for the branch", () => {
  expect(interpretGhPrList({ spawned: true, exitCode: 0, stdout: "[]\n" })).toEqual({
    url: null,
    reason: "no-pr",
  });
});

test("interpretGhPrList returns gh-missing when the gh binary could not be spawned", () => {
  expect(interpretGhPrList({ spawned: false, exitCode: -1, stdout: "" })).toEqual({
    url: null,
    reason: "gh-missing",
  });
});

test("interpretGhPrList returns gh-error on a non-zero exit (not authed, no remote, …)", () => {
  expect(interpretGhPrList({ spawned: true, exitCode: 1, stdout: "" })).toEqual({
    url: null,
    reason: "gh-error",
  });
});

test("interpretGhPrList returns gh-error when gh's output is not the expected JSON", () => {
  expect(interpretGhPrList({ spawned: true, exitCode: 0, stdout: "not json" })).toEqual({
    url: null,
    reason: "gh-error",
  });
});

test("makeCachedPrLinkResolver serves a cached result within the TTL without re-resolving", async () => {
  const { resolver, calls } = countingResolver({ url: "https://x/pull/1" });
  const cached = makeCachedPrLinkResolver(resolver, { ttlMs: 1000, now: () => 0 });

  expect(await cached.resolve({ worktreePath: "/w", branchName: "b" })).toEqual({ url: "https://x/pull/1" });
  expect(await cached.resolve({ worktreePath: "/w", branchName: "b" })).toEqual({ url: "https://x/pull/1" });
  expect(calls()).toBe(1);
});

test("makeCachedPrLinkResolver keys the cache per worktree+branch", async () => {
  const { resolver, calls } = countingResolver({ url: "https://x/pull/1" });
  const cached = makeCachedPrLinkResolver(resolver, { ttlMs: 1000, now: () => 0 });

  await cached.resolve({ worktreePath: "/w", branchName: "a" });
  await cached.resolve({ worktreePath: "/w", branchName: "b" });
  expect(calls()).toBe(2);
});

test("makeCachedPrLinkResolver re-resolves once the TTL has elapsed", async () => {
  const { resolver, calls } = countingResolver({ url: "https://x/pull/1" });
  let clock = 0;
  const cached = makeCachedPrLinkResolver(resolver, { ttlMs: 1000, now: () => clock });

  await cached.resolve({ worktreePath: "/w", branchName: "b" });
  clock = 1500;
  await cached.resolve({ worktreePath: "/w", branchName: "b" });
  expect(calls()).toBe(2);
});

test("makeCachedPrLinkResolver bypassCache forces a live resolve and refreshes the entry", async () => {
  const { resolver, calls } = countingResolver({ url: "https://x/pull/1" });
  const cached = makeCachedPrLinkResolver(resolver, { ttlMs: 100000, now: () => 0 });

  await cached.resolve({ worktreePath: "/w", branchName: "b" });
  await cached.resolve({ worktreePath: "/w", branchName: "b", bypassCache: true });
  expect(calls()).toBe(2);
  // The forced resolve refreshed the entry, so a following cached read is free.
  await cached.resolve({ worktreePath: "/w", branchName: "b" });
  expect(calls()).toBe(2);
});
