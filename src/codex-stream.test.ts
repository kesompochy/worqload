import { expect, test } from "bun:test";
import { classifyCodexLine, extractCodexThreadId, isCodexTurnTerminator, normalizeCodexLine } from "./codex-stream";

test("normalizeCodexLine surfaces agent_message text as the assistant message text", () => {
  const wire = { type: "item.completed", item: { id: "i1", type: "agent_message", text: "hello" } };
  expect(normalizeCodexLine(wire, "claude_assistant_message")).toEqual({ text: "hello", thinking: "", wire });
});

test("normalizeCodexLine routes reasoning item text into thinking", () => {
  const wire = { type: "item.completed", item: { id: "r1", type: "reasoning", text: "pondering" } };
  expect(normalizeCodexLine(wire, "claude_assistant_message")).toEqual({ text: "", thinking: "pondering", wire });
});

test("normalizeCodexLine flattens a tool-like item to name (item type) + input (the item)", () => {
  const item = { id: "x", type: "command_execution", command: "ls" };
  const wire = { type: "item.started", item };
  expect(normalizeCodexLine(wire, "claude_tool_use")).toEqual({
    tools: [{ name: "command_execution", input: item }],
    wire,
  });
});

test("normalizeCodexLine flattens a tool result, marking error items", () => {
  const okWire = { type: "item.completed", item: { id: "x", type: "command_execution", text: "done" } };
  expect(normalizeCodexLine(okWire, "claude_tool_result")).toEqual({
    results: [{ text: "done", isError: false }],
    wire: okWire,
  });
});

test("normalizeCodexLine summarizes system lines into text", () => {
  expect(normalizeCodexLine({ type: "error", message: "fatal" }, "claude_system").text).toBe("fatal");
  expect(normalizeCodexLine({ type: "turn.completed" }, "claude_system").text).toBe("turn.completed");
});

test("classifyCodexLine maps thread.started and turn.* to claude_system", () => {
  expect(classifyCodexLine({ type: "thread.started", thread_id: "t-1" })).toBe("claude_system");
  expect(classifyCodexLine({ type: "turn.started" })).toBe("claude_system");
  expect(classifyCodexLine({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } })).toBe("claude_system");
  expect(classifyCodexLine({ type: "turn.failed", error: { message: "boom" } })).toBe("claude_system");
});

test("classifyCodexLine maps agent_message items to claude_assistant_message", () => {
  const line = {
    type: "item.completed",
    item: { id: "i1", type: "agent_message", text: "hello" },
  };
  expect(classifyCodexLine(line)).toBe("claude_assistant_message");
});

test("classifyCodexLine maps reasoning items to claude_assistant_message", () => {
  const line = {
    type: "item.completed",
    item: { id: "r1", type: "reasoning", text: "thinking" },
  };
  expect(classifyCodexLine(line)).toBe("claude_assistant_message");
});

test("classifyCodexLine maps tool-like items (command_execution, mcp_tool_call, file_change, web_search) to claude_tool_use on start/update and claude_tool_result on completion", () => {
  for (const itemType of ["command_execution", "mcp_tool_call", "file_change", "web_search"]) {
    expect(
      classifyCodexLine({ type: "item.started", item: { id: "x", type: itemType } }),
    ).toBe("claude_tool_use");
    expect(
      classifyCodexLine({ type: "item.updated", item: { id: "x", type: itemType } }),
    ).toBe("claude_tool_use");
    expect(
      classifyCodexLine({ type: "item.completed", item: { id: "x", type: itemType } }),
    ).toBe("claude_tool_result");
  }
});

test("classifyCodexLine maps top-level error events and error items to claude_system", () => {
  expect(classifyCodexLine({ type: "error", message: "fatal" })).toBe("claude_system");
  expect(
    classifyCodexLine({ type: "item.completed", item: { id: "e", type: "error", message: "x" } }),
  ).toBe("claude_system");
});

test("classifyCodexLine falls back to claude_system for unknown shapes", () => {
  expect(classifyCodexLine({})).toBe("claude_system");
  expect(classifyCodexLine({ type: "unknown_event" })).toBe("claude_system");
});

test("extractCodexThreadId returns thread_id from thread.started events", () => {
  expect(extractCodexThreadId({ type: "thread.started", thread_id: "abc-123" })).toBe("abc-123");
  expect(extractCodexThreadId({ type: "turn.started" })).toBeNull();
  expect(extractCodexThreadId({ type: "thread.started" })).toBeNull();
});

test("isCodexTurnTerminator detects turn.completed and turn.failed", () => {
  expect(isCodexTurnTerminator({ type: "turn.completed" })).toBe(true);
  expect(isCodexTurnTerminator({ type: "turn.failed", error: { message: "x" } })).toBe(true);
  expect(isCodexTurnTerminator({ type: "turn.started" })).toBe(false);
  expect(isCodexTurnTerminator({ type: "thread.started", thread_id: "x" })).toBe(false);
  expect(isCodexTurnTerminator({ type: "item.completed", item: { id: "i", type: "agent_message", text: "" } })).toBe(false);
});
