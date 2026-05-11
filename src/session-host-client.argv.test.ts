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

test("parseHostArgs returns null when required pieces are missing", () => {
  expect(parseHostArgs(["sess-1", "--sessions-dir", "/d", "--socket-path", "/s", "--agent-endpoint", "http://x"])).toBeNull(); // no `--` / spawn command
  expect(parseHostArgs(["--sessions-dir", "/d", "--socket-path", "/s", "--agent-endpoint", "http://x", "--", "claude"])).toBeNull(); // no sessionId
  expect(parseHostArgs(["sess-1", "--socket-path", "/s", "--agent-endpoint", "http://x", "--", "claude"])).toBeNull(); // no sessions-dir
});
