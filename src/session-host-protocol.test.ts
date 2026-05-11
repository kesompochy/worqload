import { expect, test } from "bun:test";
import { encodeMessage, parseLineDelimited, type ServeToHostMessage } from "./session-host-protocol";

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
