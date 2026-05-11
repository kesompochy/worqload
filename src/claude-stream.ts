import type { EventKind } from "./event-log";

interface ParsedClaudeLine {
  type?: string;
  message?: { content?: unknown };
  [key: string]: unknown;
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
