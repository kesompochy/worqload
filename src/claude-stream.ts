import type { EventKind } from "./event-log";

interface ParsedClaudeLine {
  type?: string;
  message?: { content?: unknown; stop_reason?: unknown };
  [key: string]: unknown;
}

// stop_reason values on an assistant message that mean claude has yielded the
// turn back to the user rather than pausing to run a tool (`tool_use`). The
// interactive transcript (what the tmux driver tails) has no synthetic
// end-of-turn line, so the terminal assistant message is the turn boundary.
const TURN_YIELDING_STOP_REASONS = new Set(["end_turn", "stop_sequence"]);

// True for the `claude -p` stream-json line that closes a turn: one
// `{type:"result",...}` line is emitted once per processed user message,
// regardless of how the turn ended. The pipe driver's authoritative boundary.
export function isClaudePipeTurnEnd(parsed: ParsedClaudeLine): boolean {
  return parsed?.type === "result";
}

// True for the transcript assistant line that closes a turn. `claude -p` also
// emits this assistant message, but the pipe driver keys off the later `result`
// line instead; this predicate is for sources that lack a `result` line (the
// interactive JSONL transcript the tmux driver reads).
export function isClaudeTranscriptTurnEnd(parsed: ParsedClaudeLine): boolean {
  if (parsed?.type !== "assistant") return false;
  const stopReason = parsed.message?.stop_reason;
  return typeof stopReason === "string" && TURN_YIELDING_STOP_REASONS.has(stopReason);
}

export function classifyClaudeLine(parsed: ParsedClaudeLine): EventKind {
  const type = parsed?.type;
  const content = parsed?.message?.content;
  const blocks = Array.isArray(content) ? content : null;

  switch (type) {
    case "assistant":
      if (blocks?.some((b) => (b as { type?: string })?.type === "tool_use")) {
        return "claude_tool_use";
      }
      return "claude_assistant_message";
    case "user":
      if (blocks?.some((b) => (b as { type?: string })?.type === "tool_result")) {
        return "claude_tool_result";
      }
      return "claude_system";
    default:
      return "claude_system";
  }
}

export async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void | Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buf += decoder.decode();
      if (buf.length > 0) await onLine(buf);
      break;
    }
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim() === "") continue;
      await onLine(line);
    }
  }
}
