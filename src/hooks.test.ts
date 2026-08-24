import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { cleanupAll, makeTmpDir } from "./test-helpers";
import { loadSessionCreateHooks, runCommands, runSessionCreateHooks } from "./hooks";

afterEach(cleanupAll);

test("loadSessionCreateHooks returns [] when the config file is absent", async () => {
  const dir = makeTmpDir("hooks-config");
  expect(await loadSessionCreateHooks(join(dir, "config.yaml"))).toEqual([]);
});

test("loadSessionCreateHooks returns [] when the key is absent from the file", async () => {
  const dir = makeTmpDir("hooks-config");
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, "textlint: []");
  expect(await loadSessionCreateHooks(configPath)).toEqual([]);
});

test("loadSessionCreateHooks parses hooks from file", async () => {
  const dir = makeTmpDir("hooks-config");
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, `
onSessionCreate:
  - directory: /projects/app
    commands:
      - echo setup
`);
  expect(await loadSessionCreateHooks(configPath)).toEqual([
    { directory: "/projects/app", commands: ["echo setup"] },
  ]);
});

test("runCommands executes commands in the given cwd", async () => {
  const dir = makeTmpDir("hooks-run");
  const results = await runCommands(["echo hello"], dir);
  expect(results).toHaveLength(1);
  expect(results[0].exitCode).toBe(0);
  expect(results[0].stdout.trim()).toBe("hello");
  expect(results[0].command).toBe("echo hello");
});

test("runCommands captures failure", async () => {
  const dir = makeTmpDir("hooks-run");
  const results = await runCommands(["exit 42"], dir);
  expect(results[0].exitCode).toBe(42);
});

test("runCommands executes commands sequentially", async () => {
  const dir = makeTmpDir("hooks-run");
  const results = await runCommands(
    ["echo first > out.txt", "cat out.txt"],
    dir,
  );
  expect(results).toHaveLength(2);
  expect(results[0].exitCode).toBe(0);
  expect(results[1].exitCode).toBe(0);
  expect(results[1].stdout.trim()).toBe("first");
});

test("runSessionCreateHooks runs matching hooks in worktree", async () => {
  const configDir = makeTmpDir("hooks-e2e");
  const worktree = makeTmpDir("hooks-worktree");
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `
onSessionCreate:
  - directory: ${configDir}
    commands:
      - echo ran-in-worktree > marker.txt
`);
  const results = await runSessionCreateHooks(configPath, configDir, worktree);
  expect(results).toHaveLength(1);
  expect(results[0].exitCode).toBe(0);
  const marker = await Bun.file(join(worktree, "marker.txt")).text();
  expect(marker.trim()).toBe("ran-in-worktree");
});

test("runSessionCreateHooks returns [] when no hooks match", async () => {
  const configDir = makeTmpDir("hooks-e2e");
  const worktree = makeTmpDir("hooks-worktree");
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `
onSessionCreate:
  - directory: /nonexistent/path
    commands:
      - echo should-not-run
`);
  const results = await runSessionCreateHooks(configPath, configDir, worktree);
  expect(results).toEqual([]);
});
