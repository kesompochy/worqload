import type { EventKind } from "./event-log";

// Top-level JSONL events emitted by `codex exec --json`. Mirrors the union
// declared in openai/codex's sdk/typescript/src/events.ts; we only need the
// shape for routing, not the full payload typing.
interface ParsedCodexLine {
  type?: string;
  thread_id?: string;
  item?: { type?: string; [k: string]: unknown };
  [key: string]: unknown;
}

// Items whose lifetime maps to a single tool invocation in the worqload event
// timeline: started/updated → tool_use, completed → tool_result. Anything not
// in this set is either an assistant-message-like item (rendered as a turn) or
// metadata (handled as claude_system).
const TOOL_LIKE_ITEM_TYPES = new Set([
  "command_execution",
  "mcp_tool_call",
  "file_change",
  "web_search",
]);

// agent_message and reasoning both carry text the human will want to see in
// the assistant-message stream. todo_list is treated the same so a codex
// plan-update doesn't disappear into the system noise; if that turns out to
// be misleading we can split it off later.
const MESSAGE_LIKE_ITEM_TYPES = new Set([
  "agent_message",
  "reasoning",
  "todo_list",
]);

export function classifyCodexLine(parsed: ParsedCodexLine): EventKind {
  const type = parsed?.type;
  if (type === "thread.started" || type === "turn.started" || type === "turn.completed" || type === "turn.failed") {
    return "claude_system";
  }
  if (type === "error") return "claude_system";
  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const itemType = parsed.item?.type;
    if (itemType === "error") return "claude_system";
    if (itemType && MESSAGE_LIKE_ITEM_TYPES.has(itemType)) return "claude_assistant_message";
    if (itemType && TOOL_LIKE_ITEM_TYPES.has(itemType)) {
      return type === "item.completed" ? "claude_tool_result" : "claude_tool_use";
    }
  }
  return "claude_system";
}

export function extractCodexThreadId(parsed: ParsedCodexLine): string | null {
  if (parsed?.type !== "thread.started") return null;
  const id = parsed.thread_id;
  return typeof id === "string" && id !== "" ? id : null;
}

export function isCodexTurnTerminator(parsed: ParsedCodexLine): boolean {
  return parsed?.type === "turn.completed" || parsed?.type === "turn.failed";
}
