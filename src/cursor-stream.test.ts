import { expect, test } from "bun:test";
import { classifyCursorLine, extractCursorSessionId } from "./cursor-stream";

test("classifyCursorLine maps system and result events to claude_system", () => {
  expect(classifyCursorLine({ type: "system", subtype: "init" })).toBe("claude_system");
  expect(classifyCursorLine({ type: "result", subtype: "success" })).toBe("claude_system");
});

test("classifyCursorLine maps assistant messages like claude stream-json", () => {
  expect(
    classifyCursorLine({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    }),
  ).toBe("claude_assistant_message");
});

test("classifyCursorLine maps assistant tool_use to claude_tool_use", () => {
  expect(
    classifyCursorLine({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Shell", input: {} }],
      },
    }),
  ).toBe("claude_tool_use");
});

test("extractCursorSessionId reads session_id from any cursor JSONL line", () => {
  expect(extractCursorSessionId({ type: "system", session_id: "abc-123" })).toBe("abc-123");
  expect(extractCursorSessionId({ type: "assistant", session_id: "abc-123" })).toBe("abc-123");
  expect(extractCursorSessionId({ type: "user" })).toBeNull();
});
