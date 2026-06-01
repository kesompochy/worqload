import { expect, test } from "bun:test";
import { BackpressuredWriter, encodeMessage, parseLineDelimited, type ServeToHostMessage } from "./session-host-protocol";

// A sink that mimics a backpressured socket: it accepts at most `cap` bytes per
// write and returns how many it took, recording everything it accepted so the
// test can reassemble the delivered stream.
class CappedSink {
  cap = Infinity;
  private chunks: Uint8Array[] = [];
  write(bytes: Uint8Array): number {
    const n = Math.min(bytes.length, this.cap);
    this.chunks.push(bytes.slice(0, n));
    return n;
  }
  delivered(): string {
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return new TextDecoder().decode(out);
  }
}

test("parseLineDelimited splits multiple messages on newlines", () => {
  const { messages, buffer } = parseLineDelimited<ServeToHostMessage>(
    `{"type":"hello","sinceSeq":3}\n{"type":"send_user","text":"hi"}\n`,
    "",
  );
  expect(messages).toEqual([
    { type: "hello", sinceSeq: 3 },
    { type: "send_user", text: "hi" },
  ]);
  expect(buffer).toBe("");
});

test("parseLineDelimited holds onto a partial trailing line in the buffer", () => {
  const { messages, buffer } = parseLineDelimited<ServeToHostMessage>(
    `{"type":"hello","sinceSeq":3}\n{"type":"send`,
    "",
  );
  expect(messages).toEqual([{ type: "hello", sinceSeq: 3 }]);
  expect(buffer).toBe(`{"type":"send`);
});

test("parseLineDelimited stitches an earlier partial line with the next chunk", () => {
  const first = parseLineDelimited<ServeToHostMessage>(`{"type":"send`, "");
  expect(first.messages).toEqual([]);
  const second = parseLineDelimited<ServeToHostMessage>(`_user","text":"hi"}\n`, first.buffer);
  expect(second.messages).toEqual([{ type: "send_user", text: "hi" }]);
  expect(second.buffer).toBe("");
});

test("parseLineDelimited skips empty lines and reports malformed ones via callback", () => {
  const malformed: string[] = [];
  const { messages } = parseLineDelimited<ServeToHostMessage>(
    `\n{"type":"hello","sinceSeq":1}\nnot-json\n{"type":"kill","signal":"SIGTERM"}\n`,
    "",
    (line) => {
      malformed.push(line);
    },
  );
  expect(messages).toEqual([
    { type: "hello", sinceSeq: 1 },
    { type: "kill", signal: "SIGTERM" },
  ]);
  expect(malformed).toEqual(["not-json"]);
});

test("encodeMessage appends a single newline so the parser sees one complete frame", () => {
  expect(encodeMessage({ type: "hello", sinceSeq: 0 })).toBe(`{"type":"hello","sinceSeq":0}\n`);
});

test("BackpressuredWriter delivers a whole message when the socket accepts it all at once", () => {
  const sink = new CappedSink();
  const writer = new BackpressuredWriter(sink);
  const msg = encodeMessage({ type: "hello", sinceSeq: 0 });
  writer.send(msg);
  expect(writer.hasPending).toBe(false);
  expect(sink.delivered()).toBe(msg);
});

test("BackpressuredWriter buffers the tail a backpressured socket refused and resends it on drain", () => {
  const sink = new CappedSink();
  sink.cap = 5; // the socket only takes 5 bytes per write
  const writer = new BackpressuredWriter(sink);
  const msg = encodeMessage({ type: "send_user", text: "hello world" });
  writer.send(msg);
  expect(writer.hasPending).toBe(true);
  while (writer.hasPending) writer.flush(); // each drain pushes out the next slice
  expect(sink.delivered()).toBe(msg); // nothing lost, nothing reordered
});

test("BackpressuredWriter keeps messages in order: a send during backpressure queues behind the tail", () => {
  const sink = new CappedSink();
  sink.cap = 4;
  const writer = new BackpressuredWriter(sink);
  const first = encodeMessage({ type: "hello", sinceSeq: 1 });
  const second = encodeMessage({ type: "kill", signal: "SIGTERM" });
  writer.send(first);
  writer.send(second); // must not overtake first's unwritten tail
  while (writer.hasPending) writer.flush();
  expect(sink.delivered()).toBe(first + second);
  // Framing survives: the parser recovers both frames, in order.
  const { messages } = parseLineDelimited<ServeToHostMessage>(sink.delivered(), "");
  expect(messages).toEqual([
    { type: "hello", sinceSeq: 1 },
    { type: "kill", signal: "SIGTERM" },
  ]);
});
