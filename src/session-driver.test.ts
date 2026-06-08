import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentLineFormat,
  claudePipeDriver,
  emitAgentLine,
  emitStderrLine,
  parseAgentLine,
  type SessionDriverEvent,
} from "./session-driver";

const MOCK = join(import.meta.dir, "__fixtures__", "mock-claude.ts");

test("parseAgentLine parses JSON and wraps an unparseable line in a raw envelope", () => {
  expect(parseAgentLine('{"type":"assistant","x":1}')).toEqual({ type: "assistant", x: 1 });
  expect(parseAgentLine("not json")).toEqual({ type: "raw", raw: "not json" });
});

test("emitAgentLine emits the classified+normalized event, then turn_completed only on a boundary", async () => {
  const format: AgentLineFormat = {
    classify: () => "claude_assistant_message",
    normalize: (parsed, kind) => ({ kind, text: String(parsed.done) }),
    isTurnEnd: (parsed) => parsed.done === true,
  };

  const open: SessionDriverEvent[] = [];
  await emitAgentLine({ done: false }, format, (e) => {
    open.push(e);
  });
  expect(open.map((e) => e.kind)).toEqual(["claude_assistant_message"]);
  // The emitted payload is the normalizer's output, not the raw parsed line.
  expect(open[0]?.payload).toEqual({ kind: "claude_assistant_message", text: "false" });

  const closed: SessionDriverEvent[] = [];
  await emitAgentLine({ done: true }, format, (e) => {
    closed.push(e);
  });
  // Classified event first, normalized turn boundary second.
  expect(closed.map((e) => e.kind)).toEqual(["claude_assistant_message", "turn_completed"]);
});

test("emitStderrLine surfaces a stderr line as a claude_system event", async () => {
  const events: SessionDriverEvent[] = [];
  await emitStderrLine("boom", (e) => {
    events.push(e);
  });
  expect(events).toEqual([{ kind: "claude_system", payload: { type: "stderr", text: "boom" } }]);
});

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
