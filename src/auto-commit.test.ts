import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { autoCommit } from "./auto-commit";

function tmpDir(): string {
  return join(tmpdir(), `worqload-autocommit-${crypto.randomUUID()}`);
}

async function initGitRepo(dir: string): Promise<void> {
  const fs = require("fs");
  fs.mkdirSync(dir, { recursive: true });
  const run = async (cmd: string[]) => {
    const proc = Bun.spawn(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };
  await run(["git", "init"]);
  await run(["git", "config", "user.email", "test@test.com"]);
  await run(["git", "config", "user.name", "Test"]);
  // Initial commit so HEAD exists
  await Bun.write(join(dir, ".gitkeep"), "");
  await run(["git", "add", "-A"]);
  await run(["git", "commit", "-m", "initial"]);
}

async function getLastCommitMessage(dir: string): Promise<string> {
  const proc = Bun.spawn(["git", "log", "-1", "--format=%s"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function getCommitCount(dir: string): Promise<number> {
  const proc = Bun.spawn(["git", "rev-list", "--count", "HEAD"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return parseInt(out.trim(), 10);
}

test("autoCommit commits when tests pass", async () => {
  const dir = tmpDir();
  await initGitRepo(dir);
  await Bun.write(join(dir, "new-file.txt"), "hello");

  const result = await autoCommit("Add greeting feature", dir, ["true"]);

  expect(result).toBe(true);
  const msg = await getLastCommitMessage(dir);
  expect(msg).toContain("Add greeting feature");
  const count = await getCommitCount(dir);
  expect(count).toBe(2); // initial + auto-commit
});

test("autoCommit skips commit when tests fail", async () => {
  const dir = tmpDir();
  await initGitRepo(dir);
  await Bun.write(join(dir, "new-file.txt"), "hello");

  const result = await autoCommit("Failing task", dir, ["false"]);

  expect(result).toBe(false);
  const count = await getCommitCount(dir);
  expect(count).toBe(1); // only initial
});

test("autoCommit returns false when nothing to commit", async () => {
  const dir = tmpDir();
  await initGitRepo(dir);

  const result = await autoCommit("No changes", dir, ["true"]);

  expect(result).toBe(false);
  const count = await getCommitCount(dir);
  expect(count).toBe(1); // only initial
});

test("autoCommit derives commit message from task title", async () => {
  const dir = tmpDir();
  await initGitRepo(dir);
  await Bun.write(join(dir, "feature.ts"), "export const x = 1;");

  await autoCommit("Implement user authentication", dir, ["true"]);

  const msg = await getLastCommitMessage(dir);
  expect(msg).toBe("worqload: Implement user authentication");
});

test("autoCommit handles task title with special characters", async () => {
  const dir = tmpDir();
  await initGitRepo(dir);
  await Bun.write(join(dir, "fix.ts"), "export const y = 2;");

  const result = await autoCommit('Fix "quotes" & <angles>', dir, ["true"]);

  expect(result).toBe(true);
  const msg = await getLastCommitMessage(dir);
  expect(msg).toBe('worqload: Fix "quotes" & <angles>');
});
