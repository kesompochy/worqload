import { expect, test } from "bun:test";
import { join } from "node:path";
import type { SessionDriverEvent } from "./session-driver";
import { cursorPipeDriver } from "./session-driver-cursor";

const MOCK = join(import.meta.dir, "__fixtures__", "mock-cursor.ts");

function testEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "BUN_INSTALL"]) {
    const v = process.env[k];
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

function collectorSink(events: SessionDriverEvent[]) {
  return async (e: SessionDriverEvent) => {
    events.push(e);
  };
}

const PREFIX = ["-p", "--output-format", "stream-json", "--force", "--trust"];

test("cursorPipeDriver runs agent -p for the first turn, capturing session_id and forwarding events", async () => {
  const events: SessionDriverEvent[] = [];
  const driver = await cursorPipeDriver({
    spawnCommand: ["bun", MOCK, "echo", ...PREFIX],
    env: testEnv(),
    onEvent: collectorSink(events),
    log: () => {},
  });

  await driver.sendUserMessage("hello", "bootstrap");

  const init = events.find((e) => (e.payload as { type?: string })?.type === "system");
  expect(init).toBeDefined();
  expect((init?.payload as { session_id?: string })?.session_id).toMatch(/^mock-session-\d+$/);

  const message = events.find((e) => e.kind === "claude_assistant_message");
  expect(message).toBeDefined();
  expect(
    ((message?.payload as { message?: { content?: Array<{ text?: string }> } })?.message?.content?.[0]?.text),
  ).toContain("echo: hello");

  driver.kill("SIGTERM");
  await driver.exited;
});

test("cursorPipeDriver reuses session_id on a second send via --resume", async () => {
  const events: SessionDriverEvent[] = [];
  const driver = await cursorPipeDriver({
    spawnCommand: ["bun", MOCK, "echo", ...PREFIX],
    env: testEnv(),
    onEvent: collectorSink(events),
    log: () => {},
  });

  await driver.sendUserMessage("first", "bootstrap");
  const firstSession = (events.find((e) => (e.payload as { type?: string })?.type === "system")
    ?.payload as { session_id?: string })?.session_id;
  expect(firstSession).toBeDefined();

  events.length = 0;
  await driver.sendUserMessage("second", "send_user");
  const resumed = events.find((e) => (e.payload as { type?: string })?.type === "system");
  expect((resumed?.payload as { session_id?: string })?.session_id).toBe(firstSession);

  driver.kill("SIGTERM");
  await driver.exited;
});

test("cursorPipeDriver passed priorAgentSessionId resumes that session on the FIRST turn", async () => {
  const events: SessionDriverEvent[] = [];
  const driver = await cursorPipeDriver({
    spawnCommand: ["bun", MOCK, "echo", ...PREFIX],
    env: testEnv(),
    onEvent: collectorSink(events),
    log: () => {},
    priorAgentSessionId: "prior-session-abc",
  });

  await driver.sendUserMessage("first", "bootstrap");
  const init = events.find((e) => (e.payload as { type?: string })?.type === "system");
  expect((init?.payload as { session_id?: string })?.session_id).toBe("prior-session-abc");

  driver.kill("SIGTERM");
  await driver.exited;
});
