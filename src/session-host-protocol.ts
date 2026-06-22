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

// The subset of Bun's `Socket` this writer needs. `write` performs a partial
// write under backpressure, returning the number of bytes the socket accepted.
export interface ByteSink {
  write(bytes: Uint8Array): number;
}

// Bun's `Socket.write` does not block: when the send buffer is full it writes
// only a prefix and returns how many bytes it took, leaving the caller to send
// the rest once the socket drains. Ignoring that return value silently drops
// the tail — which both truncates the oversized message and desyncs the
// newline framing of every message after it (the next message starts mid-line).
// This buffers the unwritten tail and flushes it, in order, when `drain` fires.
export class BackpressuredWriter {
  private pending = new Uint8Array(0);

  constructor(private readonly sink: ByteSink) {}

  // Encode and send a message, writing as much as the socket accepts now and
  // queueing the rest. Once anything is queued, later messages queue behind it
  // so the stream stays in order.
  send(message: string): void {
    const bytes = new TextEncoder().encode(message);
    if (this.pending.length > 0) {
      this.pending = concatBytes(this.pending, bytes);
      return;
    }
    const written = this.sink.write(bytes);
    if (written < bytes.length) {
      this.pending = bytes.subarray(written);
    }
  }

  // Call from the socket's `drain` handler to push out the queued tail.
  flush(): void {
    if (this.pending.length === 0) return;
    const written = this.sink.write(this.pending);
    this.pending = written >= this.pending.length ? new Uint8Array(0) : this.pending.subarray(written);
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
