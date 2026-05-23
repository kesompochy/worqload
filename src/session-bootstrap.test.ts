import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildProtocolPrefix } from "./session-bootstrap";

// session-bootstrap.ts resolves the default wq-issue-comment path relative to
// its own location. This test file sits in the same src/ directory, so the
// same join reproduces what that default should be.
const installedScriptPath = join(import.meta.dir, "..", "bin", "wq-issue-comment");

describe("buildProtocolPrefix", () => {
  test("substitutes the base branch placeholder", () => {
    const prefix = buildProtocolPrefix("release-2026", installedScriptPath);
    expect(prefix).toContain("release-2026");
    expect(prefix).not.toContain("{{baseBranch}}");
  });

  test("substitutes the wq-issue-comment path with the given path", () => {
    const prefix = buildProtocolPrefix("main", "/opt/worqload/bin/wq-issue-comment");
    expect(prefix).toContain("/opt/worqload/bin/wq-issue-comment");
    expect(prefix).not.toContain("{{wqIssueComment}}");
  });

  test("defaults the wq-issue-comment path to the script in the worqload install", () => {
    // The default must be the absolute path of the installed script: a session
    // runs in a worktree of an arbitrary target repo, so a relative `bin/...`
    // would only resolve when the target repo happens to be worqload itself.
    expect(existsSync(installedScriptPath)).toBe(true);
    expect(buildProtocolPrefix("main")).toContain(installedScriptPath);
  });

  test("leaves no unfilled placeholders", () => {
    expect(buildProtocolPrefix("main")).not.toContain("{{");
  });
});
