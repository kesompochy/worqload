import { test, expect, describe, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { mkdirSync, existsSync, readlinkSync, lstatSync, writeFileSync, symlinkSync } from "fs";
import { makeRepoFromTemplate } from "./test-helpers";
import {
  createSessionWorktree,
  removeWorktree,
  resolveBaseCommit,
  currentBranch,
  listWorktreeFiles,
  readWorktreeFile,
  searchFileContents,
  gitDiff,
  resolveDiffBase,
  listFilesAtRevision,
  readFileAtRevision,
} from "./worktree";

const cleanGitEnv = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: cleanGitEnv });
}

// The base branch is "trunk" rather than "main"/"master" so commits made by
// the test setup don't trip the user's global pre-commit branch-protection hook.
const TEST_BASE_BRANCH = "trunk";

function createTempGitRepo(): string {
  return makeRepoFromTemplate("worktree", (dir) => {
    git(["init"], dir);
    git(["checkout", "-b", TEST_BASE_BRANCH], dir);
    git(["config", "user.email", "test@test.com"], dir);
    git(["config", "user.name", "Test"], dir);
    writeFileSync(join(dir, "README.md"), "# test repo\n");
    git(["add", "."], dir);
    git(["commit", "-m", "initial"], dir);
  });
}

const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const dir of cleanupDirs) {
    const result = git(["worktree", "list", "--porcelain"], dir);
    const output = new TextDecoder().decode(result.stdout);
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ") && line.includes(".worktrees")) {
        const wtPath = line.replace("worktree ", "");
        git(["worktree", "remove", "--force", wtPath], dir);
      }
    }
    try {
      const { rmSync } = await import("fs");
      rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  cleanupDirs.length = 0;
});

describe("createSessionWorktree", () => {
  test("creates a git worktree directory at <repo>/.worktrees/<shortId>", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const sessionId = crypto.randomUUID();
    const reportsDir = join(repoDir, ".worqload", "sessions", sessionId, "reports");

    const { worktreePath } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      branchName: `test-${sessionId.slice(0, 8)}`,
      reportsDirAbsolute: reportsDir,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
    expect(worktreePath).toBe(join(resolve(repoDir), ".worktrees", sessionId.slice(0, 8)));
  });

  test("creates .worqload-reports symlink pointing to reports dir", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const sessionId = crypto.randomUUID();
    const reportsDir = resolve(join(repoDir, ".worqload", "sessions", sessionId, "reports"));

    const { worktreePath } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      branchName: `test-${sessionId.slice(0, 8)}`,
      reportsDirAbsolute: reportsDir,
    });

    const linkPath = join(worktreePath, ".worqload-reports");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(reportsDir);
  });

  test("creates an empty .worqload-draft directory at the worktree root for the agent's report drafts", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const sessionId = crypto.randomUUID();
    const reportsDir = join(repoDir, ".worqload", "sessions", sessionId, "reports");

    const { worktreePath } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      branchName: `test-${sessionId.slice(0, 8)}`,
      reportsDirAbsolute: reportsDir,
    });

    const draftPath = join(worktreePath, ".worqload-draft");
    expect(lstatSync(draftPath).isDirectory()).toBe(true);
  });

  test("creates the reports directory if missing", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const sessionId = crypto.randomUUID();
    const reportsDir = join(repoDir, ".worqload", "sessions", sessionId, "reports");

    expect(existsSync(reportsDir)).toBe(false);
    await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      branchName: `test-${sessionId.slice(0, 8)}`,
      reportsDirAbsolute: reportsDir,
    });
    expect(existsSync(reportsDir)).toBe(true);
  });

  test("uses the supplied branch name verbatim", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const sessionId = crypto.randomUUID();
    const reportsDir = join(repoDir, ".worqload", "sessions", sessionId, "reports");
    const requested = "fix-login-bug";

    const { branchName } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      branchName: requested,
      reportsDirAbsolute: reportsDir,
    });
    expect(branchName).toBe(requested);
  });
});

describe("removeWorktree", () => {
  test("removes the worktree directory and the branch", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const sessionId = crypto.randomUUID();
    const reportsDir = join(repoDir, ".worqload", "sessions", sessionId, "reports");

    const { worktreePath, branchName } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      branchName: `test-${sessionId.slice(0, 8)}`,
      reportsDirAbsolute: reportsDir,
    });
    expect(existsSync(worktreePath)).toBe(true);

    await removeWorktree(worktreePath, branchName, repoDir);

    expect(existsSync(worktreePath)).toBe(false);
    const result = git(["branch", "--list", branchName], repoDir);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("");
  });
});

describe("listWorktreeFiles", () => {
  test("lists tracked and untracked files, excluding gitignored ones", async () => {
    const repoDir = createTempGitRepo(); // README.md committed by setup
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, ".gitignore"), "ignored/\n*.log\n");
    mkdirSync(join(repoDir, "ignored"), { recursive: true });
    writeFileSync(join(repoDir, "ignored", "secret.txt"), "x");
    writeFileSync(join(repoDir, "debug.log"), "x");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.ts"), "x");
    git(["add", "src/a.ts"], repoDir); // tracked but uncommitted
    writeFileSync(join(repoDir, "new file.txt"), "x"); // untracked, not ignored, has a space

    const files = await listWorktreeFiles(repoDir);
    expect(files).toContain("README.md");
    expect(files).toContain("src/a.ts");
    expect(files).toContain(".gitignore");
    expect(files).toContain("new file.txt");
    expect(files).not.toContain("ignored/secret.txt");
    expect(files).not.toContain("debug.log");
    expect(files).toEqual([...files].sort());
  });

  test("returns an empty list when the worktree directory is gone", async () => {
    const files = await listWorktreeFiles(join(tmpdir(), `worqload-missing-${crypto.randomUUID()}`));
    expect(files).toEqual([]);
  });
});

describe("readWorktreeFile", () => {
  test("returns text content for a regular file", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "hello.txt"), "line1\nline2\n");
    expect(await readWorktreeFile(repoDir, "hello.txt")).toEqual({ kind: "text", content: "line1\nline2\n" });
  });

  test("rejects paths that escape the worktree", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const escaping = await readWorktreeFile(repoDir, `${"../".repeat(20)}etc/hosts`);
    expect(escaping.kind).toBe("denied");
    const absolute = await readWorktreeFile(repoDir, "/etc/hosts");
    expect(absolute.kind).toBe("denied");
  });

  test("rejects symlinks that point outside the worktree", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const outside = join(tmpdir(), `worqload-outside-${crypto.randomUUID()}.txt`);
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(repoDir, "leak"));
    expect((await readWorktreeFile(repoDir, "leak")).kind).toBe("denied");
  });

  test("returns not-found for a missing file", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    expect((await readWorktreeFile(repoDir, "nope.txt")).kind).toBe("not-found");
  });

  test("returns not-a-file for a directory", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    mkdirSync(join(repoDir, "adir"));
    expect((await readWorktreeFile(repoDir, "adir")).kind).toBe("not-a-file");
  });

  test("flags binary files", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "bin.dat"), Buffer.from([0x68, 0x69, 0x00, 0x01, 0xff]));
    expect((await readWorktreeFile(repoDir, "bin.dat")).kind).toBe("binary");
  });

  test("flags files over the size limit", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "big.txt"), "a".repeat(3 * 1024 * 1024));
    const result = await readWorktreeFile(repoDir, "big.txt");
    expect(result.kind).toBe("too-large");
    if (result.kind === "too-large") expect(result.size).toBe(3 * 1024 * 1024);
  });
});

describe("searchFileContents", () => {
  test("finds case-insensitive substring matches with path, 1-based line, and the matching line", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.ts"), "const Needle = 1;\nother\nuse needle here\n");
    writeFileSync(join(repoDir, "src", "b.ts"), "nothing\n");
    writeFileSync(join(repoDir, "notes.md"), "a NEEDLE in markdown\n");

    const { matches, truncated } = await searchFileContents(
      repoDir,
      ["src/a.ts", "src/b.ts", "notes.md"],
      "needle",
    );
    expect(truncated).toBe(false);
    expect(matches).toEqual([
      { path: "src/a.ts", line: 1, text: "const Needle = 1;" },
      { path: "src/a.ts", line: 3, text: "use needle here" },
      { path: "notes.md", line: 1, text: "a NEEDLE in markdown" },
    ]);
  });

  test("skips binary files", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "bin.dat"), Buffer.concat([Buffer.from("needle"), Buffer.from([0x00, 0x01])]));
    writeFileSync(join(repoDir, "text.txt"), "needle\n");
    const { matches } = await searchFileContents(repoDir, ["bin.dat", "text.txt"], "needle");
    expect(matches).toEqual([{ path: "text.txt", line: 1, text: "needle" }]);
  });

  test("returns no matches for an empty query", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "f.txt"), "anything\n");
    expect(await searchFileContents(repoDir, ["f.txt"], "")).toEqual({ matches: [], truncated: false });
  });

  test("caps the result count and reports truncation", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "many.txt"), Array.from({ length: 250 }, () => "needle").join("\n") + "\n");
    const { matches, truncated } = await searchFileContents(repoDir, ["many.txt"], "needle");
    expect(matches.length).toBe(200);
    expect(truncated).toBe(true);
    expect(matches[0]).toEqual({ path: "many.txt", line: 1, text: "needle" });
  });
});

describe("resolveBaseCommit / currentBranch", () => {
  test("resolveBaseCommit returns commit sha", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);

    const sha = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("currentBranch returns main on freshly initialised repo", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);

    const branch = await currentBranch(repoDir);
    expect(branch).toBe(TEST_BASE_BRANCH);
  });
});

describe("gitDiff", () => {
  async function makeWorktree(repoDir: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const { worktreePath } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      branchName: `s-${sessionId.slice(0, 8)}`,
      reportsDirAbsolute: join(repoDir, ".worqload", "sessions", sessionId, "reports"),
    });
    return worktreePath;
  }

  test("against the session-start commit, shows the branch's committed and uncommitted changes", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const worktreePath = await makeWorktree(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    writeFileSync(join(worktreePath, "committed.txt"), "committed work\n");
    git(["add", "committed.txt"], worktreePath);
    git(["commit", "-m", "session change"], worktreePath);
    writeFileSync(join(worktreePath, "README.md"), "# uncommitted edit\n");

    const diff = await gitDiff(worktreePath, baseCommit);
    expect(diff).toContain("committed.txt");
    expect(diff).toContain("committed work");
    expect(diff).toContain("uncommitted edit");
  });

  test("commits the base branch gained after the fork don't appear (the recorded base commit is fixed)", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const worktreePath = await makeWorktree(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    writeFileSync(join(worktreePath, "session-file.txt"), "session work\n");
    git(["add", "session-file.txt"], worktreePath);
    git(["commit", "-m", "session change"], worktreePath);

    // The base branch advances past the fork point — e.g. another session merged in.
    writeFileSync(join(repoDir, "other-session.txt"), "work from another session\n");
    git(["add", "other-session.txt"], repoDir);
    git(["commit", "-m", "merge another session"], repoDir);

    const diff = await gitDiff(worktreePath, baseCommit);
    expect(diff).toContain("session-file.txt");
    expect(diff).not.toContain("other-session.txt");
  });

  test("with a large context value emits the whole file, not just lines around the change", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);

    // 30-line file on the base branch; change one line deep in the middle in the
    // worktree. `git diff -U3` would hide most of the file; a huge -U value
    // means "all of it" — what the diff view wants so the human can expand
    // context locally.
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(repoDir, "many.txt"), lines.join("\n") + "\n");
    git(["add", "many.txt"], repoDir);
    git(["commit", "-m", "add many.txt"], repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    const worktreePath = await makeWorktree(repoDir);
    const changed = [...lines];
    changed[14] = "line 15 CHANGED";
    writeFileSync(join(worktreePath, "many.txt"), changed.join("\n") + "\n");

    const diff = await gitDiff(worktreePath, baseCommit, 1_000_000);
    expect(diff).toContain("line 15 CHANGED");
    expect(diff).toContain("line 1");
    expect(diff).toContain("line 30");
  });
});

describe("resolveDiffBase", () => {
  async function makeWorktree(repoDir: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const { worktreePath } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      branchName: `s-${sessionId.slice(0, 8)}`,
      reportsDirAbsolute: join(repoDir, ".worqload", "sessions", sessionId, "reports"),
    });
    return worktreePath;
  }

  function revParse(ref: string, cwd: string): string {
    return new TextDecoder().decode(git(["rev-parse", ref], cwd).stdout).trim();
  }

  test("returns the recorded base commit when nothing has moved", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const worktreePath = await makeWorktree(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    expect(await resolveDiffBase(worktreePath, TEST_BASE_BRANCH, baseCommit)).toBe(baseCommit);
  });

  test("ignores base-branch commits that haven't been merged into the branch", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const worktreePath = await makeWorktree(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    writeFileSync(join(repoDir, "other.txt"), "other\n");
    git(["add", "other.txt"], repoDir);
    git(["commit", "-m", "base branch advances"], repoDir);

    expect(await resolveDiffBase(worktreePath, TEST_BASE_BRANCH, baseCommit)).toBe(baseCommit);
  });

  test("moves forward to the absorbed tip after the base branch is merged in (update branch)", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const worktreePath = await makeWorktree(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    writeFileSync(join(worktreePath, "session.txt"), "session\n");
    git(["add", "session.txt"], worktreePath);
    git(["commit", "-m", "session change"], worktreePath);

    writeFileSync(join(repoDir, "other.txt"), "other\n");
    git(["add", "other.txt"], repoDir);
    git(["commit", "-m", "base branch advances"], repoDir);
    const advancedTip = revParse(TEST_BASE_BRANCH, repoDir);

    git(["merge", "--no-edit", TEST_BASE_BRANCH], worktreePath);

    expect(await resolveDiffBase(worktreePath, TEST_BASE_BRANCH, baseCommit)).toBe(advancedTip);
  });

  test("keeps the recorded base commit when the base branch trails it", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    // Fork the worktree from an advanced trunk, then rewind trunk behind that point.
    writeFileSync(join(repoDir, "ahead.txt"), "ahead\n");
    git(["add", "ahead.txt"], repoDir);
    git(["commit", "-m", "trunk moves ahead"], repoDir);
    const worktreePath = await makeWorktree(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    git(["reset", "--hard", "HEAD~1"], repoDir);

    expect(await resolveDiffBase(worktreePath, TEST_BASE_BRANCH, baseCommit)).toBe(baseCommit);
  });
});

describe("listFilesAtRevision / readFileAtRevision", () => {
  async function makeWorktree(repoDir: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const { worktreePath } = await createSessionWorktree({
      sessionId,
      repoDir,
      baseBranch: TEST_BASE_BRANCH,
      branchName: `s-${sessionId.slice(0, 8)}`,
      reportsDirAbsolute: join(repoDir, ".worqload", "sessions", sessionId, "reports"),
    });
    return worktreePath;
  }

  test("lists tracked files as they existed at the given revision, ignoring later worktree changes", async () => {
    const repoDir = createTempGitRepo(); // commit: README.md
    cleanupDirs.push(repoDir);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.ts"), "export const a = 1\n");
    git(["add", "src/a.ts"], repoDir);
    git(["commit", "-m", "add a"], repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    const worktreePath = await makeWorktree(repoDir);
    // After the fork, add and remove files in the worktree — these must not
    // appear in the Before snapshot.
    writeFileSync(join(worktreePath, "src", "b.ts"), "export const b = 2\n");
    git(["add", "src/b.ts"], worktreePath);
    git(["commit", "-m", "add b"], worktreePath);
    git(["rm", "src/a.ts"], worktreePath);
    git(["commit", "-m", "remove a"], worktreePath);

    const before = await listFilesAtRevision(worktreePath, baseCommit);
    expect(before).toContain("README.md");
    expect(before).toContain("src/a.ts");
    expect(before).not.toContain("src/b.ts");
  });

  test("returns an empty list when the revision can't be resolved", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const worktreePath = await makeWorktree(repoDir);
    expect(await listFilesAtRevision(worktreePath, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toEqual([]);
  });

  test("reads the file blob as it existed at the given revision", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "hello.txt"), "before\n");
    git(["add", "hello.txt"], repoDir);
    git(["commit", "-m", "before"], repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    const worktreePath = await makeWorktree(repoDir);
    writeFileSync(join(worktreePath, "hello.txt"), "after\n");
    git(["add", "hello.txt"], worktreePath);
    git(["commit", "-m", "after"], worktreePath);

    expect(await readFileAtRevision(worktreePath, baseCommit, "hello.txt")).toEqual({ kind: "text", content: "before\n" });
  });

  test("returns not-found for files that did not exist at the revision", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    const worktreePath = await makeWorktree(repoDir);
    writeFileSync(join(worktreePath, "new.txt"), "new\n");
    git(["add", "new.txt"], worktreePath);
    git(["commit", "-m", "new"], worktreePath);

    expect((await readFileAtRevision(worktreePath, baseCommit, "new.txt")).kind).toBe("not-found");
  });

  test("rejects paths that escape the repo", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    const worktreePath = await makeWorktree(repoDir);

    expect((await readFileAtRevision(worktreePath, baseCommit, "../etc/hosts")).kind).toBe("denied");
    expect((await readFileAtRevision(worktreePath, baseCommit, "/etc/hosts")).kind).toBe("denied");
    expect((await readFileAtRevision(worktreePath, baseCommit, "")).kind).toBe("denied");
  });

  test("flags binary blobs without buffering them as text", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "bin.dat"), Buffer.from([0x68, 0x69, 0x00, 0x01, 0xff]));
    git(["add", "bin.dat"], repoDir);
    git(["commit", "-m", "add bin"], repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    const worktreePath = await makeWorktree(repoDir);

    expect((await readFileAtRevision(worktreePath, baseCommit, "bin.dat")).kind).toBe("binary");
  });
});

