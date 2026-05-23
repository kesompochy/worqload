import { expect, test } from "bun:test";
import { join } from "node:path";
import type { SessionDriverEvent } from "./session-driver";
import { codexPipeDriver } from "./session-driver-codex";

const MOCK = join(import.meta.dir, "__fixtures__", "mock-codex.ts");

function testEnv(): Record<string, string> {
  // The driver runs `bun MOCK <mode> ...`; bun needs PATH to resolve
  // dependencies and for the shebang. Forward the test process's env minimally.
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

test("codexPipeDriver runs `codex exec --json -` for the first turn, capturing thread_id and forwarding events", async () => {
  const events: SessionDriverEvent[] = [];
  const driver = await codexPipeDriver({
    spawnCommand: ["bun", MOCK, "echo"],
    env: testEnv(),
    onEvent: collectorSink(events),
    log: () => {},
  });

  await driver.sendUserMessage("hello", "bootstrap");

  const started = events.find((e) => (e.payload as { type?: string })?.type === "thread.started");
  expect(started).toBeDefined();
  expect((started?.payload as { thread_id?: string })?.thread_id).toMatch(/^mock-thread-\d+$/);

  const message = events.find(
    (e) =>
      e.kind === "claude_assistant_message" &&
      (e.payload as { item?: { type?: string } })?.item?.type === "agent_message",
  );
  expect(message).toBeDefined();
  expect(((message?.payload as { item?: { text?: string } })?.item?.text)).toContain("echo: hello");

  driver.kill("SIGTERM");
  await driver.exited;
});

test("codexPipeDriver reuses the captured thread_id on a second send via `exec resume`", async () => {
  const events: SessionDriverEvent[] = [];
  const driver = await codexPipeDriver({
    spawnCommand: ["bun", MOCK, "echo"],
    env: testEnv(),
    onEvent: collectorSink(events),
    log: () => {},
  });

  await driver.sendUserMessage("first", "bootstrap");
  const firstThread = (events.find((e) => (e.payload as { type?: string })?.type === "thread.started")
    ?.payload as { thread_id?: string })?.thread_id;
  expect(firstThread).toBeDefined();

  events.length = 0;
  await driver.sendUserMessage("second", "send_user");
  // The resumed invocation echoes back the same thread_id the mock was started with.
  const resumeStarted = events.find((e) => (e.payload as { type?: string })?.type === "thread.started");
  expect((resumeStarted?.payload as { thread_id?: string })?.thread_id).toBe(firstThread);

  driver.kill("SIGTERM");
  await driver.exited;
});

test("codexPipeDriver serialises concurrent sendUserMessage calls (second waits for first to finish)", async () => {
  const events: SessionDriverEvent[] = [];
  const order: string[] = [];
  const driver = await codexPipeDriver({
    spawnCommand: ["bun", MOCK, "echo"],
    env: testEnv(),
    onEvent: async (e) => {
      events.push(e);
      const text = (e.payload as { item?: { text?: string } })?.item?.text;
      if (text) order.push(text);
    },
    log: () => {},
  });

  const a = driver.sendUserMessage("aaa", "send_user");
  const b = driver.sendUserMessage("bbb", "send_user");
  await Promise.all([a, b]);

  // The order of agent_message text emissions reflects the order of turns.
  const echoes = order.filter((t) => t.startsWith("echo:"));
  expect(echoes).toEqual(["echo: aaa", "echo: bbb"]);

  driver.kill("SIGTERM");
  await driver.exited;
});

test("codexPipeDriver.exited resolves only after kill, not after a turn naturally completes", async () => {
  const driver = await codexPipeDriver({
    spawnCommand: ["bun", MOCK, "echo"],
    env: testEnv(),
    onEvent: () => {},
    log: () => {},
  });

  await driver.sendUserMessage("once", "bootstrap");

  // Race exited against a short timer; the timer should win.
  const winner = await Promise.race([
    driver.exited.then(() => "exited" as const),
    new Promise<"timer">((r) => setTimeout(() => r("timer"), 100)),
  ]);
  expect(winner).toBe("timer");

  driver.kill("SIGTERM");
  await driver.exited;
});
