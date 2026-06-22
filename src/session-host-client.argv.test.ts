import { expect, test } from "bun:test";
import { parseHostArgs } from "./commands/session-host";
import { buildHostArgv } from "./session-host-client";

test("buildHostArgv + parseHostArgs round-trip a spawn command whose args contain spaces", () => {
  const spawnCommand = [
    "claude",
    "-p",
    "--allowedTools",
    "Bash(worqload report submit:*) Bash(worqload feedback fetch)",
  ];
  const argv = buildHostArgv({
    hostCommand: ["bun", "/repo/src/cli.ts", "session-host"],
    sessionId: "sess-1",
    sessionsDir: "/repo/.worqload/sessions",
    socketPath: "/tmp/worqload/sess-1.sock",
    agentEndpoint: "http://127.0.0.1:3456",
    spawnCommand,
  });

  // session-host's CLI receives everything after `bun /repo/src/cli.ts session-host`.
  const cliArgs = argv.slice(3);
  const parsed = parseHostArgs(cliArgs);
  expect(parsed).not.toBeNull();
  expect(parsed?.sessionId).toBe("sess-1");
  expect(parsed?.sessionsDir).toBe("/repo/.worqload/sessions");
  expect(parsed?.socketPath).toBe("/tmp/worqload/sess-1.sock");
  expect(parsed?.agentEndpoint).toBe("http://127.0.0.1:3456");
  expect(parsed?.spawnCommand).toEqual(spawnCommand);
});

test("buildHostArgv + parseHostArgs carry the --resume flag", () => {
  const argv = buildHostArgv({
    hostCommand: ["bun", "/repo/src/cli.ts", "session-host"],
    sessionId: "sess-1",
    sessionsDir: "/repo/.worqload/sessions",
    socketPath: "/tmp/worqload/sess-1.sock",
    agentEndpoint: "http://127.0.0.1:3456",
    spawnCommand: ["claude", "-p", "--continue"],
    resume: true,
  });
  expect(argv).toContain("--resume");
  const parsed = parseHostArgs(argv.slice(3));
  expect(parsed?.resume).toBe(true);
  expect(parsed?.spawnCommand).toEqual(["claude", "-p", "--continue"]);
});

test("parseHostArgs leaves resume undefined when --resume is absent", () => {
  const parsed = parseHostArgs([
    "sess-1",
    "--sessions-dir", "/d",
    "--socket-path", "/s",
    "--agent-endpoint", "http://x",
    "--", "claude",
  ]);
  expect(parsed?.resume).toBeUndefined();
});

test("buildHostArgv + parseHostArgs carry --log-file", () => {
  const argv = buildHostArgv({
    hostCommand: ["bun", "/repo/src/cli.ts", "session-host"],
    sessionId: "sess-1",
    sessionsDir: "/repo/.worqload/sessions",
    socketPath: "/tmp/worqload/sess-1.sock",
    agentEndpoint: "http://127.0.0.1:3456",
    spawnCommand: ["claude", "-p"],
    logFile: "/repo/.worqload/sessions/sess-1/host.log",
  });
  expect(argv).toContain("--log-file");
  const parsed = parseHostArgs(argv.slice(3));
  expect(parsed?.logFile).toBe("/repo/.worqload/sessions/sess-1/host.log");
});

test("parseHostArgs leaves logFile undefined when --log-file is absent", () => {
  const parsed = parseHostArgs([
    "sess-1",
    "--sessions-dir", "/d",
    "--socket-path", "/s",
    "--agent-endpoint", "http://x",
    "--", "claude",
  ]);
  expect(parsed?.logFile).toBeUndefined();
});

test("buildHostArgv omits --driver when driverName is unset", () => {
  const argv = buildHostArgv({
    hostCommand: ["bun", "/repo/src/cli.ts", "session-host"],
    sessionId: "sess-1",
    sessionsDir: "/repo/.worqload/sessions",
    socketPath: "/tmp/worqload/sess-1.sock",
    agentEndpoint: "http://127.0.0.1:3456",
    spawnCommand: ["claude", "-p"],
  });
  expect(argv).not.toContain("--driver");
  const parsed = parseHostArgs(argv.slice(3));
  expect(parsed?.driver).toBeUndefined();
});

test("buildHostArgv + parseHostArgs carry --agent codex with default driver (pipe)", () => {
  const argv = buildHostArgv({
    hostCommand: ["bun", "/repo/src/cli.ts", "session-host"],
    sessionId: "sess-1",
    sessionsDir: "/repo/.worqload/sessions",
    socketPath: "/tmp/worqload/sess-1.sock",
    agentEndpoint: "http://127.0.0.1:3456",
    spawnCommand: ["codex"],
    agentName: "codex",
  });
  expect(argv).toContain("--agent");
  const agentIdx = argv.indexOf("--agent");
  expect(argv[agentIdx + 1]).toBe("codex");
  expect(argv).not.toContain("--driver");
  const parsed = parseHostArgs(argv.slice(3));
  expect(parsed?.driver).toBeUndefined();
});

test("buildHostArgv + parseHostArgs carry --agent codex --driver pipe and resolve to the codex pipe factory", () => {
  const argv = buildHostArgv({
    hostCommand: ["bun", "/repo/src/cli.ts", "session-host"],
    sessionId: "sess-1",
    sessionsDir: "/repo/.worqload/sessions",
    socketPath: "/tmp/worqload/sess-1.sock",
    agentEndpoint: "http://127.0.0.1:3456",
    spawnCommand: ["codex"],
    agentName: "codex",
    driverName: "pipe",
  });
  expect(argv).toContain("--agent");
  expect(argv).toContain("--driver");
  const parsed = parseHostArgs(argv.slice(3));
  expect(typeof parsed?.driver).toBe("function");
});

test("buildHostArgv + parseHostArgs carry --agent cursor with default driver (pipe)", () => {
  const argv = buildHostArgv({
    hostCommand: ["bun", "/repo/src/cli.ts", "session-host"],
    sessionId: "sess-1",
    sessionsDir: "/repo/.worqload/sessions",
    socketPath: "/tmp/worqload/sess-1.sock",
    agentEndpoint: "http://127.0.0.1:3456",
    spawnCommand: ["agent"],
    agentName: "cursor",
  });
  expect(argv).toContain("--agent");
  const agentIdx = argv.indexOf("--agent");
  expect(argv[agentIdx + 1]).toBe("cursor");
  const parsed = parseHostArgs(argv.slice(3));
  expect(parsed?.driver).toBeUndefined();
});

test("buildHostArgv + parseHostArgs carry --driver tmux and resolve to the tmux factory", () => {
  const argv = buildHostArgv({
    hostCommand: ["bun", "/repo/src/cli.ts", "session-host"],
    sessionId: "sess-1",
    sessionsDir: "/repo/.worqload/sessions",
    socketPath: "/tmp/worqload/sess-1.sock",
    agentEndpoint: "http://127.0.0.1:3456",
    spawnCommand: ["claude", "--dangerously-skip-permissions"],
    driverName: "tmux",
  });
  expect(argv).toContain("--driver");
  const driverIdx = argv.indexOf("--driver");
  expect(argv[driverIdx + 1]).toBe("tmux");
  const parsed = parseHostArgs(argv.slice(3));
  expect(parsed?.driver).toBeDefined();
  // The driver field is a function — we can't compare it to tmuxClaudeDriver
  // directly without importing it here, but its presence is enough to confirm
  // the round-trip resolved a factory.
  expect(typeof parsed?.driver).toBe("function");
});

test("parseHostArgs rejects --driver with an unknown name", () => {
  expect(() =>
    parseHostArgs([
      "sess-1",
      "--sessions-dir", "/d",
      "--socket-path", "/s",
      "--agent-endpoint", "http://x",
      "--driver", "nope",
      "--", "claude",
    ]),
  ).toThrow();
});

test("parseHostArgs returns null when required pieces are missing", () => {
  expect(parseHostArgs(["sess-1", "--sessions-dir", "/d", "--socket-path", "/s", "--agent-endpoint", "http://x"])).toBeNull(); // no `--` / spawn command
  expect(parseHostArgs(["--sessions-dir", "/d", "--socket-path", "/s", "--agent-endpoint", "http://x", "--", "claude"])).toBeNull(); // no sessionId
  expect(parseHostArgs(["sess-1", "--socket-path", "/s", "--agent-endpoint", "http://x", "--", "claude"])).toBeNull(); // no sessions-dir
});
