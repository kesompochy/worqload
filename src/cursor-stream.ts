import { classifyClaudeLine } from "./claude-stream";
import type { EventKind } from "./event-log";

interface ParsedCursorLine {
  type?: string;
  session_id?: string;
  [key: string]: unknown;
}

export function classifyCursorLine(parsed: ParsedCursorLine): EventKind {
  const type = parsed?.type;
  if (type === "system" || type === "result") return "claude_system";
  return classifyClaudeLine(parsed);
}

export function extractCursorSessionId(parsed: ParsedCursorLine): string | null {
  const id = parsed?.session_id;
  return typeof id === "string" && id !== "" ? id : null;
}
