import { afterEach, expect, test } from "bun:test";
import { cleanupAll, fakeWorktreeOps, inProcessHostLauncher, trackCleanup } from "./test-helpers";
import { loadSessionMeta, type AgentName } from "./session";
import { buildDefaultSpawnCommand, startServer, type HostLauncher } from "./web-server";

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

test("buildDefaultSpawnCommand for cursor returns the agent -p prefix without the prompt (the driver appends it)", () => {
  const argv = buildDefaultSpawnCommand("cursor", "pipe");
  expect(argv[0]).toBe("agent");
  expect(argv).toContain("-p");
  expect(argv).toContain("stream-json");
  expect(argv).toContain("--force");
  expect(argv).toContain("--trust");
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

test("POST /sessions persists the selected agentName and passes its runtime to the host launcher", async () => {
  const launches: Array<{ agentName?: AgentName; spawnCommand: string[]; driverName?: string }> = [];
  const baseLauncher = inProcessHostLauncher();
  const hostLauncher: HostLauncher = async (req) => {
    launches.push({
      agentName: req.meta.agentName,
      spawnCommand: req.spawnCommand,
      driverName: req.driverName,
    });
    return baseLauncher(req);
  };
  const started = await startServer({
    port: 0,
    branchNameGenerator: async () => null,
    hostLauncher,
    worktreeOps: fakeWorktreeOps(),
    reportRewriter: async (raw) => raw,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));

  const res = await fetch(`http://127.0.0.1:${started.server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "use codex", baseBranch: "trunk", agentName: "codex" }),
  });

  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.meta.agentName).toBe("codex");
  expect((await loadSessionMeta(body.meta.id, started.ctx.sessionsDir))?.agentName).toBe("codex");
  expect(launches).toHaveLength(1);
  expect(launches[0].agentName).toBe("codex");
  expect(launches[0].spawnCommand[0]).toBe("codex");
  expect(launches[0].driverName).toBe("codex");
});

test("POST /sessions defaults agentName to the server agent", async () => {
  const started = await startServer({
    port: 0,
    agentName: "codex",
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    reportRewriter: async (raw) => raw,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));

  const res = await fetch(`http://127.0.0.1:${started.server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "use default", baseBranch: "trunk" }),
  });

  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.meta.agentName).toBe("codex");
});

test("startServer with agentName=cursor defaults spawnCommand to the cursor agent prefix", async () => {
  const started = await startServer({
    port: 0,
    agentName: "cursor",
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    reportRewriter: async (raw) => raw,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  expect(started.ctx.spawnCommand[0]).toBe("agent");
});

test("POST /sessions persists cursor agentName and passes driver cursor to the host launcher", async () => {
  const launches: Array<{ agentName?: AgentName; spawnCommand: string[]; driverName?: string }> = [];
  const baseLauncher = inProcessHostLauncher();
  const hostLauncher: HostLauncher = async (req) => {
    launches.push({
      agentName: req.meta.agentName,
      spawnCommand: req.spawnCommand,
      driverName: req.driverName,
    });
    return baseLauncher(req);
  };
  const started = await startServer({
    port: 0,
    branchNameGenerator: async () => null,
    hostLauncher,
    worktreeOps: fakeWorktreeOps(),
    reportRewriter: async (raw) => raw,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));

  const res = await fetch(`http://127.0.0.1:${started.server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "use cursor", baseBranch: "trunk", agentName: "cursor" }),
  });

  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.meta.agentName).toBe("cursor");
  expect(launches).toHaveLength(1);
  expect(launches[0].agentName).toBe("cursor");
  expect(launches[0].spawnCommand[0]).toBe("agent");
  expect(launches[0].driverName).toBe("cursor");
});

test("POST /sessions rejects unknown agentName", async () => {
  const started = await startServer({
    port: 0,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    reportRewriter: async (raw) => raw,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));

  const res = await fetch(`http://127.0.0.1:${started.server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "bad agent", baseBranch: "trunk", agentName: "gpt" }),
  });

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "agentName must be 'claude', 'codex', or 'cursor'" });
});
