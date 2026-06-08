import { expect, test } from "bun:test";
import { join } from "node:path";
import { claudePipeDriver, type SessionDriverEvent } from "./session-driver";

const MOCK = join(import.meta.dir, "__fixtures__", "mock-claude.ts");

function testEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "BUN_INSTALL"]) {
    const v = process.env[k];
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

test("claudePipeDriver emits a normalized turn_completed event from the stream-json result line", async () => {
  const events: SessionDriverEvent[] = [];
  const driver = await claudePipeDriver({
    spawnCommand: ["bun", MOCK, "turn"],
    env: testEnv(),
    onEvent: async (e) => {
      events.push(e);
    },
    log: () => {},
  });

  await driver.sendUserMessage("hello", "bootstrap");

  const deadline = Date.now() + 2000;
  while (!events.some((e) => e.kind === "turn_completed") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // Driver contract: a turn boundary surfaces as the normalized event, and the
  // assistant message's own end_turn does not separately trip it (the pipe
  // driver keys off the result line only) — exactly one per processed message.
  expect(events.filter((e) => e.kind === "turn_completed").length).toBe(1);

  driver.kill("SIGTERM");
  await driver.exited;
});
