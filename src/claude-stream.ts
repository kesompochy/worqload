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

// Translate a classified claude wire line into the normalized domain payload
// consumers read, so the events UI never has to know claude's stream-json
// shape (message.content blocks, the result line, ...). The original parsed
// line is kept under `wire` for the debug payload dump only — consumers must
// not interpret it. classifyClaudeLine decides `kind`; this shapes the payload
// for that kind.
export function normalizeClaudeLine(parsed: ParsedClaudeLine, kind: EventKind): Record<string, unknown> {
  switch (kind) {
    case "claude_assistant_message":
      return {
        text: joinBlockField(parsed, "text", "text"),
        thinking: joinBlockField(parsed, "thinking", "thinking"),
        wire: parsed,
      };
    case "claude_tool_use":
      return {
        tools: blocksOfType(parsed, "tool_use").map((b) => ({
          name: typeof b.name === "string" ? b.name : "tool",
          input: b.input ?? {},
        })),
        wire: parsed,
      };
    case "claude_tool_result":
      return {
        results: blocksOfType(parsed, "tool_result").map((b) => ({
          text: textFromContent(b.content),
          isError: b.is_error === true,
        })),
        wire: parsed,
      };
    default:
      return { text: claudeSystemText(parsed), wire: parsed };
  }
}

interface ContentBlock {
  type?: string;
  [key: string]: unknown;
}

function blocksOfType(parsed: ParsedClaudeLine, type: string): ContentBlock[] {
  const content = parsed?.message?.content;
  return Array.isArray(content) ? (content as ContentBlock[]).filter((b) => b && b.type === type) : [];
}

function joinBlockField(parsed: ParsedClaudeLine, type: string, field: string): string {
  return blocksOfType(parsed, type)
    .map((b) => b[field])
    .filter((t): t is string => typeof t === "string")
    .join("\n")
    .trim();
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: unknown })?.text === "string"
            ? (part as { text: string }).text
            : JSON.stringify(part, null, 2),
      )
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content, null, 2);
}

// The claude_system kind is a grab-bag (stderr, unparsed lines, the result
// line, init/system subtypes). Reduce each to a single human-readable line so
// the UI can render it without inspecting the wire shape.
function claudeSystemText(parsed: ParsedClaudeLine): string {
  if (parsed?.type === "stderr" && typeof parsed.text === "string") return parsed.text;
  if (parsed?.type === "raw" && typeof parsed.raw === "string") return parsed.raw;
  if (parsed?.type === "result") {
    const result = typeof parsed.result === "string" ? parsed.result : "";
    return `result${parsed.is_error ? " (error)" : ""}${result ? `: ${result}` : ""}`;
  }
  if (typeof parsed?.subtype === "string") return `system: ${parsed.subtype}`;
  return "system";
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
