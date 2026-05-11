import type { Event } from "./event-log";

// Messages sent over the per-session unix socket between `worqload serve`
// (client) and `worqload session-host` (server).
//
// Wire format: one JSON object per line, terminated by `\n`. UTF-8.

export type ServeToHostMessage =
  | { type: "hello"; sinceSeq: number }
  | { type: "send_user"; text: string }
  | { type: "kill"; signal: "SIGTERM" | "SIGKILL" };

export type HostToServeMessage =
  | { type: "ready" }
  | { type: "event"; event: Event }
  | { type: "replay_done"; lastSeq: number }
  | { type: "exited"; code: number | null };

export type AnyMessage = ServeToHostMessage | HostToServeMessage;

// Decodes a buffer of newline-delimited JSON messages. Returns the parsed
// messages and the unconsumed tail (a partial line if the buffer ended
// mid-message). Malformed lines are skipped silently — the caller may log
// them by passing onMalformed.
export function parseLineDelimited<T>(
  chunk: string,
  buffer: string,
  onMalformed?: (line: string, err: unknown) => void,
): { messages: T[]; buffer: string } {
  const combined = buffer + chunk;
  const messages: T[] = [];
  let rest = combined;
  while (true) {
    const idx = rest.indexOf("\n");
    if (idx === -1) break;
    const line = rest.slice(0, idx);
    rest = rest.slice(idx + 1);
    if (line.trim() === "") continue;
    try {
      messages.push(JSON.parse(line) as T);
    } catch (err) {
      onMalformed?.(line, err);
    }
  }
  return { messages, buffer: rest };
}

export function encodeMessage(msg: AnyMessage): string {
  return `${JSON.stringify(msg)}\n`;
}
