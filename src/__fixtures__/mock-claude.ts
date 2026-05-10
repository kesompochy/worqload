#!/usr/bin/env bun
// A test stand-in for `claude --input-format stream-json --output-format stream-json`.
// Emits stream-json lines to stdout and reacts to user messages on stdin.
//
// Modes (selected via the first positional arg):
//   init    : emit one system init line, then exit 0
//   echo    : emit init, then for each stdin user message emit an assistant text reply
//   hang    : emit init, then read stdin forever (used to test kill)
//   crash   : emit init, then exit 1
//   tool    : emit init, then an assistant turn with a tool_use block, then exit 0

const mode = process.argv[2] ?? "init";

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

writeLine({ type: "system", subtype: "init", session_id: "mock" });

if (mode === "init") {
  process.exit(0);
}

if (mode === "crash") {
  process.exit(1);
}

if (mode === "tool") {
  writeLine({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "tu_1", name: "Read", input: { path: "x" } },
      ],
    },
  });
  process.exit(0);
}

if (mode === "echo") {
  const decoder = new TextDecoder();
  let buf = "";
  process.stdin.on("data", (chunk: Uint8Array) => {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const text =
        (parsed as { message?: { content?: { text?: string }[] | string } })
          ?.message?.content;
      const echo =
        typeof text === "string"
          ? text
          : Array.isArray(text)
            ? text.map(p => p?.text ?? "").join("")
            : "";
      writeLine({
        type: "assistant",
        message: { content: [{ type: "text", text: `echo: ${echo}` }] },
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (mode === "hang") {
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => process.exit(0));
  // keep alive
  setInterval(() => {}, 1_000_000);
}
