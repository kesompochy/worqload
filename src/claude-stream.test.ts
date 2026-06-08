import { expect, test } from "bun:test";
import { isClaudePipeTurnEnd, isClaudeTranscriptTurnEnd } from "./claude-stream";

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
