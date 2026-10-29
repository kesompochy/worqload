import { expect, test } from "bun:test";
import { join } from "node:path";
import { claudePipeDriver, type SessionDriverEvent, type SessionDriverFactory } from "./session-driver";
import { codexPipeDriver } from "./session-driver-codex";
import { cursorPipeDriver } from "./session-driver-cursor";

// The SessionDriver contract every consumer of turn_completed relies on: one
// turn_completed per processed user message. The tmux driver turns transcript
// lines rather than sent messages into turns, so its boundaries are covered in
// session-driver-tmux.test.ts against transcript fixtures.
const FIXTURES = join(import.meta.dir, "__fixtures__");
const DRIVERS: { name: string; factory: SessionDriverFactory; spawnCommand: string[] }[] = [
  { name: "claude pipe", factory: claudePipeDriver, spawnCommand: ["bun", join(FIXTURES, "mock-claude.ts"), "turn"] },
  { name: "codex", factory: codexPipeDriver, spawnCommand: ["bun", join(FIXTURES, "mock-codex.ts"), "echo"] },
  { name: "cursor", factory: cursorPipeDriver, spawnCommand: ["bun", join(FIXTURES, "mock-cursor.ts"), "echo"] },
];

function testEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "BUN_INSTALL"]) {
    const v = process.env[k];
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

async function waitForTurnCount(events: SessionDriverEvent[], count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (events.filter((e) => e.kind === "turn_completed").length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

for (const { name, factory, spawnCommand } of DRIVERS) {
  test(`${name} driver emits exactly one turn_completed per user message`, async () => {
    const events: SessionDriverEvent[] = [];
    const driver = await factory({
      spawnCommand,
      env: testEnv(),
      onEvent: async (e) => {
        events.push(e);
      },
      log: () => {},
    });

    await driver.sendUserMessage("first", "bootstrap");
    await waitForTurnCount(events, 1);
    await driver.sendUserMessage("second", "send_user");
    await waitForTurnCount(events, 2);
    await new Promise((r) => setTimeout(r, 100));

    expect(events.filter((e) => e.kind === "turn_completed").length).toBe(2);
    expect(events.at(-1)?.kind).toBe("turn_completed");

    driver.kill("SIGTERM");
    await driver.exited;
  });
}
