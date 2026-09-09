import { test, expect } from "bun:test";
import { parseGitRemoteUrl, buildBlobPermalink, reverseInsteadOf, parseInsteadOfConfig } from "./permalink";

test("parseGitRemoteUrl reads the scp-like form git uses for SSH remotes", () => {
  expect(parseGitRemoteUrl("git@github.com:owner/repo.git")).toEqual({ webBaseUrl: "https://github.com/owner/repo" });
  expect(parseGitRemoteUrl("git@github.com:owner/repo")).toEqual({ webBaseUrl: "https://github.com/owner/repo" });
});

test("parseGitRemoteUrl reads ssh:// URLs, dropping any port", () => {
  expect(parseGitRemoteUrl("ssh://git@git.example.com/owner/repo.git")).toEqual({ webBaseUrl: "https://git.example.com/owner/repo" });
  expect(parseGitRemoteUrl("ssh://git@git.example.com:2222/owner/repo.git")).toEqual({ webBaseUrl: "https://git.example.com/owner/repo" });
});

test("parseGitRemoteUrl reads https/http URLs and strips a trailing .git", () => {
  expect(parseGitRemoteUrl("https://github.com/owner/repo.git")).toEqual({ webBaseUrl: "https://github.com/owner/repo" });
  expect(parseGitRemoteUrl("https://github.com/owner/repo")).toEqual({ webBaseUrl: "https://github.com/owner/repo" });
  expect(parseGitRemoteUrl("http://git.example.com/owner/repo.git")).toEqual({ webBaseUrl: "https://git.example.com/owner/repo" });
});

test("parseGitRemoteUrl keeps nested group paths (GHES/GitLab-style subgroups)", () => {
  expect(parseGitRemoteUrl("git@git.example.com:group/sub/repo.git")).toEqual({ webBaseUrl: "https://git.example.com/group/sub/repo" });
});

test("parseGitRemoteUrl returns null for hosts whose blob URL shape differs", () => {
  expect(parseGitRemoteUrl("git@gitlab.com:owner/repo.git")).toBeNull();
  expect(parseGitRemoteUrl("https://bitbucket.org/owner/repo.git")).toBeNull();
});

test("parseGitRemoteUrl returns null for local paths and unrecognized URLs", () => {
  expect(parseGitRemoteUrl("/srv/git/repo.git")).toBeNull();
  expect(parseGitRemoteUrl("../sibling-repo")).toBeNull();
  expect(parseGitRemoteUrl("")).toBeNull();
});

test("buildBlobPermalink builds a file URL with no line fragment", () => {
  expect(buildBlobPermalink({ webBaseUrl: "https://github.com/owner/repo", ref: "abc123", path: "src/foo.ts" }))
    .toBe("https://github.com/owner/repo/blob/abc123/src/foo.ts");
});

test("buildBlobPermalink adds #L for a single line and #L-L for a range", () => {
  expect(buildBlobPermalink({ webBaseUrl: "https://github.com/owner/repo", ref: "abc123", path: "src/foo.ts", lineStart: 10 }))
    .toBe("https://github.com/owner/repo/blob/abc123/src/foo.ts#L10");
  expect(buildBlobPermalink({ webBaseUrl: "https://github.com/owner/repo", ref: "abc123", path: "src/foo.ts", lineStart: 10, lineEnd: 20 }))
    .toBe("https://github.com/owner/repo/blob/abc123/src/foo.ts#L10-L20");
  expect(buildBlobPermalink({ webBaseUrl: "https://github.com/owner/repo", ref: "abc123", path: "src/foo.ts", lineStart: 10, lineEnd: 10 }))
    .toBe("https://github.com/owner/repo/blob/abc123/src/foo.ts#L10");
});

test("buildBlobPermalink percent-encodes path segments but keeps the slashes", () => {
  expect(buildBlobPermalink({ webBaseUrl: "https://github.com/owner/repo", ref: "abc123", path: "dir with space/a+b.ts" }))
    .toBe("https://github.com/owner/repo/blob/abc123/dir%20with%20space/a%2Bb.ts");
});

test("reverseInsteadOf replaces a rewritten prefix with the canonical one", () => {
  const entries = [
    { rewritten: "ssh://git@github-emu/gmo-pepabo/", canonical: "ssh://git@github.com/gmo-pepabo/" },
    { rewritten: "git@github-emu:gmo-pepabo/", canonical: "git@github.com:gmo-pepabo/" },
  ];
  expect(reverseInsteadOf("ssh://git@github-emu/gmo-pepabo/repo.git", entries))
    .toBe("ssh://git@github.com/gmo-pepabo/repo.git");
  expect(reverseInsteadOf("git@github-emu:gmo-pepabo/repo.git", entries))
    .toBe("git@github.com:gmo-pepabo/repo.git");
});

test("reverseInsteadOf returns the URL unchanged when no entry matches", () => {
  const entries = [
    { rewritten: "ssh://git@github-emu/gmo-pepabo/", canonical: "ssh://git@github.com/gmo-pepabo/" },
  ];
  expect(reverseInsteadOf("git@github.com:owner/repo.git", entries))
    .toBe("git@github.com:owner/repo.git");
});

test("reverseInsteadOf picks the longest matching rewritten prefix", () => {
  const entries = [
    { rewritten: "ssh://git@alias/", canonical: "ssh://git@host/" },
    { rewritten: "ssh://git@alias/org/", canonical: "ssh://git@host/org/" },
  ];
  expect(reverseInsteadOf("ssh://git@alias/org/repo.git", entries))
    .toBe("ssh://git@host/org/repo.git");
});

test("reverseInsteadOf handles empty entries list", () => {
  expect(reverseInsteadOf("git@github.com:o/r.git", [])).toBe("git@github.com:o/r.git");
});

test("parseInsteadOfConfig extracts entries from git config --get-regexp output", () => {
  const raw = [
    "url.ssh://git@github-emu/gmo-pepabo/.insteadof ssh://git@github.com/gmo-pepabo/",
    "url.git@github-emu:gmo-pepabo/.insteadof git@github.com:gmo-pepabo/",
  ].join("\n");
  expect(parseInsteadOfConfig(raw)).toEqual([
    { rewritten: "ssh://git@github-emu/gmo-pepabo/", canonical: "ssh://git@github.com/gmo-pepabo/" },
    { rewritten: "git@github-emu:gmo-pepabo/", canonical: "git@github.com:gmo-pepabo/" },
  ]);
});

test("parseInsteadOfConfig skips blank lines and malformed entries", () => {
  expect(parseInsteadOfConfig("")).toEqual([]);
  expect(parseInsteadOfConfig("not-a-valid-line")).toEqual([]);
  expect(parseInsteadOfConfig("some.key value")).toEqual([]);
});
