import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

let repoDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  repoDir = await mkdtemp(join(tmpdir(), "worktree-test-"));
  process.chdir(repoDir);
  await $`git init`.quiet();
  await $`git commit --allow-empty -m "initial"`.quiet();
});

afterAll(async () => {
  process.chdir(originalCwd);
  await rm(repoDir, { recursive: true, force: true });
});

test("createWorktree creates a worktree and branch", async () => {
  const { createWorktree } = await import("./worktree");
  const info = await createWorktree("abc12345");

  expect(info.path).toBe(".worqload/worktrees/abc12345");
  expect(info.branch).toBe("worqload/abc12345");

  const result = await $`git worktree list`.text();
  expect(result).toContain("abc12345");

  const branchResult = await $`git branch`.text();
  expect(branchResult).toContain("worqload/abc12345");

  await $`git worktree remove ${info.path} --force`.quiet();
  await $`git branch -D ${info.branch}`.quiet();
});

test("removeWorktree cleans up worktree and branch", async () => {
  const { createWorktree, removeWorktree } = await import("./worktree");
  const info = await createWorktree("def67890");

  await removeWorktree(info.path, info.branch);

  const result = await $`git worktree list`.text();
  expect(result).not.toContain("def67890");

  const branchResult = await $`git branch`.text();
  expect(branchResult).not.toContain("worqload/def67890");
});

test("removeWorktree is safe when worktree does not exist", async () => {
  const { removeWorktree } = await import("./worktree");
  // Should not throw
  await removeWorktree(".worqload/worktrees/nonexistent", "worqload/nonexistent");
});

test("mergeWorktreeBranch merges branch into current", async () => {
  const { createWorktree, removeWorktree, mergeWorktreeBranch } = await import("./worktree");
  const info = await createWorktree("mrg11111");

  // Create a file in the worktree
  const filePath = join(info.path, "test-merge.txt");
  await Bun.write(filePath, "hello from worktree");
  const prevCwd = process.cwd();
  process.chdir(info.path);
  await $`git add test-merge.txt`.quiet();
  await $`git commit -m "add test file"`.quiet();
  process.chdir(prevCwd);

  const result = await mergeWorktreeBranch(info.branch);
  expect(result.merged).toBe(true);

  const file = Bun.file("test-merge.txt");
  expect(await file.text()).toBe("hello from worktree");

  await removeWorktree(info.path, info.branch);
  await $`git rm test-merge.txt`.quiet();
  await $`git commit -m "cleanup"`.quiet();
});
