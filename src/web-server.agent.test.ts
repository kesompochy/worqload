import { afterEach, expect, test } from "bun:test";
import { cleanupAll, fakeWorktreeOps, inProcessHostLauncher, trackCleanup } from "./test-helpers";
import { buildDefaultSpawnCommand, startServer } from "./web-server";

afterEach(cleanupAll);

test("buildDefaultSpawnCommand for claude/pipe returns the stream-json claude argv", () => {
  const argv = buildDefaultSpawnCommand("claude", "pipe");
  expect(argv[0]).toBe("claude");
  expect(argv).toContain("-p");
  expect(argv).toContain("stream-json");
});

test("buildDefaultSpawnCommand for claude/tmux returns the interactive claude argv with --dangerously-skip-permissions", () => {
  const argv = buildDefaultSpawnCommand("claude", "tmux");
  expect(argv[0]).toBe("claude");
  expect(argv).toContain("--dangerously-skip-permissions");
  expect(argv).not.toContain("stream-json");
});

test("buildDefaultSpawnCommand for codex returns the codex prefix without exec args (the driver appends them)", () => {
  // driverName is ignored for codex; the codex driver is the only option.
  const pipe = buildDefaultSpawnCommand("codex", "pipe");
  const tmux = buildDefaultSpawnCommand("codex", "tmux");
  expect(pipe).toEqual(tmux);
  expect(pipe[0]).toBe("codex");
  expect(pipe).toContain("--dangerously-bypass-approvals-and-sandbox");
  // The driver appends `exec --json -` (and `resume <id>` on subsequent turns);
  // having them in the prefix would double them up.
  expect(pipe).not.toContain("exec");
  expect(pipe).not.toContain("--json");
});

test("startServer with agentName=codex defaults spawnCommand to the codex prefix", async () => {
  const started = await startServer({
    port: 0,
    agentName: "codex",
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    reportRewriter: async (raw) => raw,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  expect(started.ctx.spawnCommand[0]).toBe("codex");
});
