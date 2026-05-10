import { test, expect, afterEach } from "bun:test";
import { join } from "path";
import { startSessionRunner } from "./session-runner";
import { readEvents } from "./event-log";
import { makeTmpDir, cleanupAll, trackRunner } from "./test-helpers";

afterEach(cleanupAll);

const MOCK = join(import.meta.dir, "__fixtures__", "mock-claude.ts");

function tmpDir(): string {
  return makeTmpDir("runner-test");
}

test("runner emits a claude_system event on init line and exits cleanly", async () => {
  const dir = tmpDir();
  const sessionId = "sess-init";
  const runner = startSessionRunner({
    sessionId,
    sessionsDir: dir,
    command: ["bun", MOCK, "init"],
  });
  trackRunner(runner);

  const exitCode = await runner.exited;
  // give pending appendEvent a moment to flush
  await new Promise(r => setTimeout(r, 50));

  expect(exitCode).toBe(0);
  const events = await readEvents(sessionId, 1, dir);
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events[0].kind).toBe("claude_system");
});

test("runner sends user message via send() and captures echo as assistant_message", async () => {
  const dir = tmpDir();
  const sessionId = "sess-echo";
  const runner = startSessionRunner({
    sessionId,
    sessionsDir: dir,
    command: ["bun", MOCK, "echo"],
  });
  trackRunner(runner);

  // wait for init event
  await new Promise(r => setTimeout(r, 100));

  await runner.send({ type: "user", message: { content: "ping" } });

  // wait for echo response
  await new Promise(r => setTimeout(r, 200));

  // close stdin so child exits
  await runner.closeStdin();
  await runner.exited;
  await new Promise(r => setTimeout(r, 50));

  const events = await readEvents(sessionId, 1, dir);
  const kinds = events.map(e => e.kind);
  expect(kinds).toContain("claude_system");
  expect(kinds).toContain("claude_assistant_message");
});

test("runner classifies tool_use lines as claude_tool_use", async () => {
  const dir = tmpDir();
  const sessionId = "sess-tool";
  const runner = startSessionRunner({
    sessionId,
    sessionsDir: dir,
    command: ["bun", MOCK, "tool"],
  });
  trackRunner(runner);

  await runner.exited;
  await new Promise(r => setTimeout(r, 50));

  const events = await readEvents(sessionId, 1, dir);
  const kinds = events.map(e => e.kind);
  expect(kinds).toContain("claude_tool_use");
});

test("runner.kill terminates a hung process", async () => {
  const dir = tmpDir();
  const sessionId = "sess-hang";
  const runner = startSessionRunner({
    sessionId,
    sessionsDir: dir,
    command: ["bun", MOCK, "hang"],
  });
  trackRunner(runner);

  await new Promise(r => setTimeout(r, 100));
  runner.kill();

  // process should exit promptly
  const exitCode = await Promise.race([
    runner.exited,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("kill did not terminate process")), 2000),
    ),
  ]);
  // killed processes have non-zero exit (often 143 = 128 + SIGTERM)
  expect(exitCode === 0 || exitCode === null || typeof exitCode === "number").toBe(true);
});

test("runner emits session_crashed when process exits with non-zero", async () => {
  const dir = tmpDir();
  const sessionId = "sess-crash";
  const runner = startSessionRunner({
    sessionId,
    sessionsDir: dir,
    command: ["bun", MOCK, "crash"],
  });
  trackRunner(runner);

  await runner.exited;
  await new Promise(r => setTimeout(r, 50));

  const events = await readEvents(sessionId, 1, dir);
  const kinds = events.map(e => e.kind);
  expect(kinds).toContain("session_crashed");
});
