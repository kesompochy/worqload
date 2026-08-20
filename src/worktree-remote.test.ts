import { test, expect, describe, afterEach } from "bun:test";
import { join } from "path";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolveRemoteDefaultBranch, fetchBranch } from "./worktree";

const cleanGitEnv = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: cleanGitEnv });
}

function gitStdout(args: string[], cwd: string): string {
  const r = git(args, cwd);
  return new TextDecoder().decode(r.stdout).trim();
}

const BRANCH = "trunk";

function makeRepoWithRemote(): { repoDir: string; bareDir: string } {
  const bareDir = mkdtempSync(join(tmpdir(), "worqload-bare-"));
  git(["init", "--bare"], bareDir);
  git(["symbolic-ref", "HEAD", `refs/heads/${BRANCH}`], bareDir);

  const repoDir = mkdtempSync(join(tmpdir(), "worqload-remote-test-"));
  git(["init"], repoDir);
  git(["checkout", "-b", BRANCH], repoDir);
  git(["config", "user.email", "test@test.com"], repoDir);
  git(["config", "user.name", "Test"], repoDir);
  writeFileSync(join(repoDir, "README.md"), "# test\n");
  git(["add", "."], repoDir);
  git(["commit", "--no-verify", "-m", "initial"], repoDir);
  git(["remote", "add", "origin", bareDir], repoDir);
  git(["push", "-u", "origin", BRANCH], repoDir);
  git(["remote", "set-head", "origin", BRANCH], repoDir);

  return { repoDir, bareDir };
}

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  cleanupDirs.length = 0;
});

describe("resolveRemoteDefaultBranch", () => {
  test("returns the remote default branch name", async () => {
    const { repoDir, bareDir } = makeRepoWithRemote();
    cleanupDirs.push(repoDir, bareDir);

    const branch = await resolveRemoteDefaultBranch(repoDir);
    expect(branch).toBe(BRANCH);
  });

  test("returns null when no remote exists", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "worqload-no-remote-"));
    cleanupDirs.push(repoDir);
    git(["init"], repoDir);
    git(["checkout", "-b", BRANCH], repoDir);
    git(["config", "user.email", "test@test.com"], repoDir);
    git(["config", "user.name", "Test"], repoDir);
    writeFileSync(join(repoDir, "README.md"), "# test\n");
    git(["add", "."], repoDir);
    git(["commit", "--no-verify", "-m", "initial"], repoDir);

    const branch = await resolveRemoteDefaultBranch(repoDir);
    expect(branch).toBeNull();
  });

  test("returns null when remote HEAD ref is not set", async () => {
    const { repoDir, bareDir } = makeRepoWithRemote();
    cleanupDirs.push(repoDir, bareDir);
    git(["remote", "set-head", "origin", "--delete"], repoDir);

    const branch = await resolveRemoteDefaultBranch(repoDir);
    expect(branch).toBeNull();
  });
});

describe("fetchBranch", () => {
  test("updates local branch from remote when not checked out", async () => {
    const { repoDir, bareDir } = makeRepoWithRemote();
    cleanupDirs.push(repoDir, bareDir);

    const clone2 = mkdtempSync(join(tmpdir(), "worqload-clone2-"));
    cleanupDirs.push(clone2);
    rmSync(clone2, { recursive: true });
    git(["clone", bareDir, clone2], tmpdir());
    git(["config", "user.email", "test@test.com"], clone2);
    git(["config", "user.name", "Test"], clone2);
    writeFileSync(join(clone2, "new.txt"), "new content\n");
    git(["add", "."], clone2);
    git(["commit", "--no-verify", "-m", "second commit"], clone2);
    git(["push", "origin", BRANCH], clone2);

    git(["checkout", "-b", "other-branch"], repoDir);
    const oldSha = gitStdout(["rev-parse", BRANCH], repoDir);

    await fetchBranch(repoDir, BRANCH);

    const newSha = gitStdout(["rev-parse", BRANCH], repoDir);
    expect(newSha).not.toBe(oldSha);
  });

  test("updates local branch from remote when currently checked out", async () => {
    const { repoDir, bareDir } = makeRepoWithRemote();
    cleanupDirs.push(repoDir, bareDir);

    const clone2 = mkdtempSync(join(tmpdir(), "worqload-clone2b-"));
    cleanupDirs.push(clone2);
    rmSync(clone2, { recursive: true });
    git(["clone", bareDir, clone2], tmpdir());
    git(["config", "user.email", "test@test.com"], clone2);
    git(["config", "user.name", "Test"], clone2);
    writeFileSync(join(clone2, "new.txt"), "new content\n");
    git(["add", "."], clone2);
    git(["commit", "--no-verify", "-m", "second commit"], clone2);
    git(["push", "origin", BRANCH], clone2);

    const oldSha = gitStdout(["rev-parse", BRANCH], repoDir);

    await fetchBranch(repoDir, BRANCH);

    const newSha = gitStdout(["rev-parse", BRANCH], repoDir);
    expect(newSha).not.toBe(oldSha);
  });

  test("updates origin/<branch> even when working tree is dirty and local branch can't fast-forward", async () => {
    const { repoDir, bareDir } = makeRepoWithRemote();
    cleanupDirs.push(repoDir, bareDir);

    const clone2 = mkdtempSync(join(tmpdir(), "worqload-clone2c-"));
    cleanupDirs.push(clone2);
    rmSync(clone2, { recursive: true });
    git(["clone", bareDir, clone2], tmpdir());
    git(["config", "user.email", "test@test.com"], clone2);
    git(["config", "user.name", "Test"], clone2);
    writeFileSync(join(clone2, "README.md"), "# updated\n");
    git(["add", "."], clone2);
    git(["commit", "--no-verify", "-m", "update readme"], clone2);
    git(["push", "origin", BRANCH], clone2);

    // Dirty the same file locally so pull --ff-only would fail
    writeFileSync(join(repoDir, "README.md"), "# local edit\n");

    const oldRemoteSha = gitStdout(["rev-parse", `origin/${BRANCH}`], repoDir);

    await fetchBranch(repoDir, BRANCH);

    const newRemoteSha = gitStdout(["rev-parse", `origin/${BRANCH}`], repoDir);
    expect(newRemoteSha).not.toBe(oldRemoteSha);
  });
});
