import { afterEach, expect, test } from "bun:test";
import { cleanupAll, fakeWorktreeOps, inProcessHostLauncher, makeTmpDir, trackCleanup } from "./test-helpers";
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
  // codex currently only supports pipe; the spawn command is the same regardless.
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

test("buildDefaultSpawnCommand for codex includes --model when provided", () => {
  const argv = buildDefaultSpawnCommand("codex", "pipe", "o3");
  expect(argv).toContain("--model");
  expect(argv[argv.indexOf("--model") + 1]).toBe("o3");
});

test("buildDefaultSpawnCommand for codex omits --model when not provided", () => {
  const argv = buildDefaultSpawnCommand("codex", "pipe");
  expect(argv).not.toContain("--model");
});

test("buildDefaultSpawnCommand for claude/pipe includes --model when provided", () => {
  const argv = buildDefaultSpawnCommand("claude", "pipe", "opus");
  expect(argv).toContain("--model");
  expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
});

test("buildDefaultSpawnCommand for claude/tmux includes --model when provided", () => {
  const argv = buildDefaultSpawnCommand("claude", "tmux", "opus");
  expect(argv).toContain("--model");
  expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
});

test("buildDefaultSpawnCommand for claude omits --model when not provided", () => {
  const argv = buildDefaultSpawnCommand("claude", "pipe");
  expect(argv).not.toContain("--model");
});

test("POST /sessions persists model for claude and passes it to the spawn command", async () => {
  const launches: Array<{ spawnCommand: string[] }> = [];
  const baseLauncher = inProcessHostLauncher();
  const hostLauncher: HostLauncher = async (req) => {
    launches.push({ spawnCommand: req.spawnCommand });
    return baseLauncher(req);
  };
  const started = await startServer({
    port: 0,
    repoDir: makeTmpDir("repo"),
    branchNameGenerator: async () => null,
    hostLauncher,
    worktreeOps: fakeWorktreeOps(),
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));

  const res = await fetch(`http://127.0.0.1:${started.server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "use opus", baseBranch: "trunk", model: "opus" }),
  });

  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.meta.model).toBe("opus");
  expect((await loadSessionMeta(body.meta.id, started.ctx.sessionsDir))?.model).toBe("opus");
  expect(launches).toHaveLength(1);
  expect(launches[0].spawnCommand).toContain("--model");
  expect(launches[0].spawnCommand[launches[0].spawnCommand.indexOf("--model") + 1]).toBe("opus");
});

test("POST /sessions omits model from spawn command when not specified", async () => {
  const launches: Array<{ spawnCommand: string[] }> = [];
  const baseLauncher = inProcessHostLauncher();
  const hostLauncher: HostLauncher = async (req) => {
    launches.push({ spawnCommand: req.spawnCommand });
    return baseLauncher(req);
  };
  const started = await startServer({
    port: 0,
    repoDir: makeTmpDir("repo"),
    branchNameGenerator: async () => null,
    hostLauncher,
    worktreeOps: fakeWorktreeOps(),
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));

  const res = await fetch(`http://127.0.0.1:${started.server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "no model", baseBranch: "trunk" }),
  });

  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.meta.model).toBeUndefined();
  expect(launches).toHaveLength(1);
  expect(launches[0].spawnCommand).not.toContain("--model");
});

test("startServer with agentName=codex defaults spawnCommand to the codex prefix", async () => {
  const started = await startServer({
    port: 0,
    repoDir: makeTmpDir("repo"),
    agentName: "codex",
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
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
    repoDir: makeTmpDir("repo"),
    branchNameGenerator: async () => null,
    hostLauncher,
    worktreeOps: fakeWorktreeOps(),
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
  expect(launches[0].driverName).toBe("pipe");
});

test("POST /sessions defaults agentName to the server agent", async () => {
  const started = await startServer({
    port: 0,
    repoDir: makeTmpDir("repo"),
    agentName: "codex",
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
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
    repoDir: makeTmpDir("repo"),
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
    repoDir: makeTmpDir("repo"),
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
  expect(launches[0].driverName).toBe("pipe");
});

test("POST /sessions persists model for codex and passes it to the spawn command", async () => {
  const launches: Array<{ spawnCommand: string[] }> = [];
  const baseLauncher = inProcessHostLauncher();
  const hostLauncher: HostLauncher = async (req) => {
    launches.push({ spawnCommand: req.spawnCommand });
    return baseLauncher(req);
  };
  const started = await startServer({
    port: 0,
    repoDir: makeTmpDir("repo"),
    branchNameGenerator: async () => null,
    hostLauncher,
    worktreeOps: fakeWorktreeOps(),
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));

  const res = await fetch(`http://127.0.0.1:${started.server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "use o3", baseBranch: "trunk", agentName: "codex", model: "o3" }),
  });

  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.meta.model).toBe("o3");
  expect((await loadSessionMeta(body.meta.id, started.ctx.sessionsDir))?.model).toBe("o3");
  expect(launches).toHaveLength(1);
  expect(launches[0].spawnCommand).toContain("--model");
  expect(launches[0].spawnCommand[launches[0].spawnCommand.indexOf("--model") + 1]).toBe("o3");
});

test("POST /sessions rejects unknown agentName", async () => {
  const started = await startServer({
    port: 0,
    repoDir: makeTmpDir("repo"),
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
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
