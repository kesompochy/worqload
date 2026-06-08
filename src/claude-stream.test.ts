import { expect, test } from "bun:test";
import { isClaudePipeTurnEnd, isClaudeTranscriptTurnEnd, normalizeClaudeLine } from "./claude-stream";

test("normalizeClaudeLine extracts assistant text and thinking, keeping the wire line", () => {
  const wire = {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "let me check" },
        { type: "text", text: "## done" },
      ],
    },
  };
  expect(normalizeClaudeLine(wire, "claude_assistant_message")).toEqual({
    text: "## done",
    thinking: "let me check",
    wire,
  });
});

test("normalizeClaudeLine flattens tool_use blocks to name+input", () => {
  const wire = {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] },
  };
  expect(normalizeClaudeLine(wire, "claude_tool_use")).toEqual({
    tools: [{ name: "Bash", input: { command: "bun test" } }],
    wire,
  });
});

test("normalizeClaudeLine flattens tool_result blocks to text+isError", () => {
  const wire = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", content: [{ type: "text", text: "12 pass" }] },
        { type: "tool_result", is_error: true, content: "boom" },
      ],
    },
  };
  expect(normalizeClaudeLine(wire, "claude_tool_result")).toEqual({
    results: [
      { text: "12 pass", isError: false },
      { text: "boom", isError: true },
    ],
    wire,
  });
});

test("normalizeClaudeLine summarizes system lines (stderr, raw, result, subtype) into text", () => {
  expect(normalizeClaudeLine({ type: "stderr", text: "warn" }, "claude_system").text).toBe("warn");
  expect(normalizeClaudeLine({ type: "raw", raw: "garbled" }, "claude_system").text).toBe("garbled");
  expect(normalizeClaudeLine({ type: "result", is_error: true, result: "nope" }, "claude_system").text)
    .toBe("result (error): nope");
  expect(normalizeClaudeLine({ type: "system", subtype: "init" }, "claude_system").text).toBe("system: init");
});

test("isClaudePipeTurnEnd detects the stream-json result line", () => {
  expect(isClaudePipeTurnEnd({ type: "result", is_error: false })).toBe(true);
  expect(isClaudePipeTurnEnd({ type: "assistant", message: { content: [] } })).toBe(false);
  expect(isClaudePipeTurnEnd({ type: "system", subtype: "init" })).toBe(false);
});

test("isClaudeTranscriptTurnEnd detects an assistant line that yields the turn back", () => {
  expect(isClaudeTranscriptTurnEnd({ type: "assistant", message: { content: [], stop_reason: "end_turn" } })).toBe(true);
  expect(isClaudeTranscriptTurnEnd({ type: "assistant", message: { content: [], stop_reason: "stop_sequence" } })).toBe(true);
});

test("isClaudeTranscriptTurnEnd is false while a turn is still in progress", () => {
  // tool_use means claude is continuing the turn, not yielding.
  expect(isClaudeTranscriptTurnEnd({ type: "assistant", message: { content: [], stop_reason: "tool_use" } })).toBe(false);
  // A user (tool_result) line is not a turn boundary.
  expect(isClaudeTranscriptTurnEnd({ type: "user", message: { content: [] } })).toBe(false);
  // The pipe-only result line is not a transcript terminator.
  expect(isClaudeTranscriptTurnEnd({ type: "result", is_error: false })).toBe(false);
});
