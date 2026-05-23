import { test, expect, describe, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { mkdirSync, existsSync, readlinkSync, lstatSync, writeFileSync, readFileSync, symlinkSync } from "fs";
import { makeRepoFromTemplate } from "./test-helpers";
import {
  createSessionWorktree,
  removeWorktree,
  resolveBaseCommit,
  currentBranch,
  listWorktreeFiles,
  readWorktreeFile,
  writeWorktreeFile,
  createWorktreeFile,
  deleteWorktreeFile,
  renameWorktreeFile,
  searchFileContents,
  gitDiff,
  resolveDiffBase,
  listFilesAtRevision,
  readFileAtRevision,
  ensureBaseWorktree,
  baseWorktreePathFor,
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

  test("classifies image files by extension, carrying their bytes and media type", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    // NUL bytes would otherwise sniff as `binary`; the extension wins.
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]);
    writeFileSync(join(repoDir, "pic.png"), pngBytes);
    const result = await readWorktreeFile(repoDir, "pic.png");
    expect(result.kind).toBe("image");
    if (result.kind === "image") {
      expect(result.mediaType).toBe("image/png");
      expect(Array.from(result.bytes)).toEqual(Array.from(pngBytes));
    }
  });
});

describe("writeWorktreeFile", () => {
  test("overwrites an existing file's content", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "hello.txt"), "old\n");
    expect((await writeWorktreeFile(repoDir, "hello.txt", "new\ncontent\n")).kind).toBe("ok");
    expect(readFileSync(join(repoDir, "hello.txt"), "utf8")).toBe("new\ncontent\n");
  });

  test("rejects paths that escape the worktree", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    expect((await writeWorktreeFile(repoDir, `${"../".repeat(20)}tmp/leak.txt`, "x")).kind).toBe("denied");
    expect((await writeWorktreeFile(repoDir, "/etc/hosts", "x")).kind).toBe("denied");
  });

  test("rejects symlinks that point outside the worktree", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const outside = join(tmpdir(), `worqload-outside-${crypto.randomUUID()}.txt`);
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(repoDir, "leak"));
    expect((await writeWorktreeFile(repoDir, "leak", "overwritten")).kind).toBe("denied");
    expect(readFileSync(outside, "utf8")).toBe("secret\n");
  });

  test("returns not-found for a missing file", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    expect((await writeWorktreeFile(repoDir, "nope.txt", "x")).kind).toBe("not-found");
  });

  test("returns not-a-file for a directory", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    mkdirSync(join(repoDir, "adir"));
    expect((await writeWorktreeFile(repoDir, "adir", "x")).kind).toBe("not-a-file");
  });
});

describe("createWorktreeFile", () => {
  test("creates a new file with the given content", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    expect((await createWorktreeFile(repoDir, "fresh.txt", "hello\n")).kind).toBe("ok");
    expect(readFileSync(join(repoDir, "fresh.txt"), "utf8")).toBe("hello\n");
  });

  test("creates missing parent directories", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    expect((await createWorktreeFile(repoDir, "a/b/c.txt", "deep\n")).kind).toBe("ok");
    expect(readFileSync(join(repoDir, "a", "b", "c.txt"), "utf8")).toBe("deep\n");
  });

  test("returns exists when the path is already taken", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "taken.txt"), "original\n");
    expect((await createWorktreeFile(repoDir, "taken.txt", "x")).kind).toBe("exists");
    expect(readFileSync(join(repoDir, "taken.txt"), "utf8")).toBe("original\n");
  });

  test("rejects paths that escape the worktree", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    expect((await createWorktreeFile(repoDir, `${"../".repeat(20)}tmp/leak.txt`, "x")).kind).toBe("denied");
    expect((await createWorktreeFile(repoDir, "/tmp/leak.txt", "x")).kind).toBe("denied");
  });

  test("rejects paths whose directory segment symlinks outside the worktree", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const outsideDir = join(tmpdir(), `worqload-outside-${crypto.randomUUID()}`);
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, join(repoDir, "escape"));
    expect((await createWorktreeFile(repoDir, "escape/pwned.txt", "x")).kind).toBe("denied");
    expect(existsSync(join(outsideDir, "pwned.txt"))).toBe(false);
  });
});

describe("deleteWorktreeFile", () => {
  test("removes an existing file", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "gone.txt"), "bye\n");
    expect((await deleteWorktreeFile(repoDir, "gone.txt")).kind).toBe("ok");
    expect(existsSync(join(repoDir, "gone.txt"))).toBe(false);
  });

  test("returns not-found for a missing file", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    expect((await deleteWorktreeFile(repoDir, "nope.txt")).kind).toBe("not-found");
  });

  test("returns not-a-file for a directory", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    mkdirSync(join(repoDir, "adir"));
    expect((await deleteWorktreeFile(repoDir, "adir")).kind).toBe("not-a-file");
    expect(existsSync(join(repoDir, "adir"))).toBe(true);
  });

  test("rejects paths that escape the worktree", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    expect((await deleteWorktreeFile(repoDir, `${"../".repeat(20)}etc/hosts`)).kind).toBe("denied");
    expect((await deleteWorktreeFile(repoDir, "/etc/hosts")).kind).toBe("denied");
  });

  test("rejects symlinks that point outside the worktree", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const outside = join(tmpdir(), `worqload-outside-${crypto.randomUUID()}.txt`);
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(repoDir, "leak"));
    expect((await deleteWorktreeFile(repoDir, "leak")).kind).toBe("denied");
    expect(existsSync(outside)).toBe(true);
  });
});

describe("renameWorktreeFile", () => {
  test("renames a file, preserving content", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "old.txt"), "keep me\n");
    expect((await renameWorktreeFile(repoDir, "old.txt", "new.txt")).kind).toBe("ok");
    expect(existsSync(join(repoDir, "old.txt"))).toBe(false);
    expect(readFileSync(join(repoDir, "new.txt"), "utf8")).toBe("keep me\n");
  });

  test("creates missing parent directories of the destination", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "flat.txt"), "moved\n");
    expect((await renameWorktreeFile(repoDir, "flat.txt", "nested/dir/deep.txt")).kind).toBe("ok");
    expect(readFileSync(join(repoDir, "nested", "dir", "deep.txt"), "utf8")).toBe("moved\n");
  });

  test("returns not-found when the source is missing", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    expect((await renameWorktreeFile(repoDir, "ghost.txt", "new.txt")).kind).toBe("not-found");
  });

  test("returns not-a-file when the source is a directory", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    mkdirSync(join(repoDir, "adir"));
    expect((await renameWorktreeFile(repoDir, "adir", "bdir")).kind).toBe("not-a-file");
  });

  test("returns exists when the destination is already taken", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "from.txt"), "from\n");
    writeFileSync(join(repoDir, "to.txt"), "to\n");
    expect((await renameWorktreeFile(repoDir, "from.txt", "to.txt")).kind).toBe("exists");
    expect(readFileSync(join(repoDir, "from.txt"), "utf8")).toBe("from\n");
    expect(readFileSync(join(repoDir, "to.txt"), "utf8")).toBe("to\n");
  });

  test("rejects a source or destination that escapes the worktree", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "real.txt"), "x\n");
    expect((await renameWorktreeFile(repoDir, `${"../".repeat(20)}etc/hosts`, "new.txt")).kind).toBe("denied");
    expect((await renameWorktreeFile(repoDir, "real.txt", `${"../".repeat(20)}tmp/leak.txt`)).kind).toBe("denied");
    expect((await renameWorktreeFile(repoDir, "real.txt", "/tmp/leak.txt")).kind).toBe("denied");
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

describe("ensureBaseWorktree", () => {
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

  test("materialises a sibling worktree at the diff base, with files matching that revision", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    writeFileSync(join(repoDir, "tracked.txt"), "before\n");
    git(["add", "tracked.txt"], repoDir);
    git(["commit", "-m", "tracked v1"], repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);

    const sessionWorktreePath = await makeWorktree(repoDir);
    // Diverge the session worktree from the base; the base worktree must
    // *not* see this change.
    writeFileSync(join(sessionWorktreePath, "tracked.txt"), "after\n");
    git(["add", "tracked.txt"], sessionWorktreePath);
    git(["commit", "-m", "tracked v2"], sessionWorktreePath);

    const basePath = await ensureBaseWorktree(sessionWorktreePath, repoDir, baseCommit);
    expect(basePath).toBe(baseWorktreePathFor(sessionWorktreePath));
    expect(existsSync(basePath)).toBe(true);
    expect(await Bun.file(join(basePath, "tracked.txt")).text()).toBe("before\n");
  });

  test("re-uses the cached worktree on a second call with the same base commit", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const baseCommit = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    const sessionWorktreePath = await makeWorktree(repoDir);

    const first = await ensureBaseWorktree(sessionWorktreePath, repoDir, baseCommit);
    // Drop a marker file in the base worktree; a re-add would wipe it.
    writeFileSync(join(first, "marker.tmp"), "x");
    const second = await ensureBaseWorktree(sessionWorktreePath, repoDir, baseCommit);
    expect(second).toBe(first);
    expect(existsSync(join(second, "marker.tmp"))).toBe(true);
  });

  test("recreates the worktree when the diff base has moved", async () => {
    const repoDir = createTempGitRepo();
    cleanupDirs.push(repoDir);
    const firstBase = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    const sessionWorktreePath = await makeWorktree(repoDir);
    await ensureBaseWorktree(sessionWorktreePath, repoDir, firstBase);

    // Advance the base branch and resolve a fresh base commit.
    writeFileSync(join(repoDir, "advance.txt"), "x\n");
    git(["add", "advance.txt"], repoDir);
    git(["commit", "-m", "advance trunk"], repoDir);
    const secondBase = await resolveBaseCommit(TEST_BASE_BRANCH, repoDir);
    expect(secondBase).not.toBe(firstBase);

    const updated = await ensureBaseWorktree(sessionWorktreePath, repoDir, secondBase);
    expect(existsSync(join(updated, "advance.txt"))).toBe(true);
  });
});

