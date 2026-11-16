#!/usr/bin/env bun
// A test stand-in for `claude --input-format stream-json --output-format stream-json`.
// Emits stream-json lines to stdout and reacts to user messages on stdin.
//
// Modes (selected via the first positional arg):
//   init    : emit one system init line, then exit 0
//   echo    : emit init, then for each stdin user message emit an assistant text reply
//   hang    : emit init, then read stdin forever (used to test kill)
//   crash   : emit init, then exit 1
//   startup-failure : skip init, emit only an error result carrying a fresh
//             session_id, then exit 1 — what claude does when it refuses to
//             start (e.g. org settings not loaded yet) and writes no transcript
//   tool    : emit init, then an assistant turn with a tool_use block, then exit 0
//   say     : emit init, then one assistant turn whose text is argv[3], then exit 0
//   env     : emit init, then emit a system line carrying the worqload env vars, then hang
//   replies : answer the k-th stdin user message with argv[3 + k] as one turn
//             (assistant text + result line). `{{input}}` in a reply becomes the
//             message text and `{{env:NAME}}` the value of env var NAME.

const mode = process.argv[2] ?? "init";

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (mode === "startup-failure") {
  writeLine({ type: "result", subtype: "error_during_execution", session_id: "never-started", is_error: true, num_turns: 0 });
  process.exit(1);
}

writeLine({ type: "system", subtype: "init", session_id: "mock" });

if (mode === "env") {
  writeLine({
    type: "system",
    subtype: "worqload_env",
    sessionId: process.env.WORQLOAD_SESSION_ID ?? null,
    endpoint: process.env.WORQLOAD_ENDPOINT ?? null,
  });
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => process.exit(0));
  setInterval(() => {}, 1_000_000);
}

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

if (mode === "say") {
  // Emit a chosen assistant text, then exit once the driver closes stdin.
  // Used to feed the report rewriter an exact output (e.g. the suppression
  // sentinel) without running a real agent.
  writeLine({
    type: "assistant",
    message: { content: [{ type: "text", text: process.argv[3] ?? "" }] },
  });
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => process.exit(0));
}

if (mode === "turn") {
  const decoder = new TextDecoder();
  let buf = "";
  process.stdin.on("data", (chunk: Uint8Array) => {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim() === "") continue;
      writeLine({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "reply" }],
          stop_reason: "end_turn",
        },
      });
      writeLine({ type: "result", subtype: "success", session_id: "mock", cost_usd: 0, duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 1, result: "" });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (mode === "replies") {
  const replies = process.argv.slice(3);
  let answered = 0;
  const decoder = new TextDecoder();
  let buf = "";
  process.stdin.on("data", (chunk: Uint8Array) => {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim() === "") continue;
      const content = (JSON.parse(line) as { message?: { content?: { text?: string }[] | string } }).message?.content;
      const input = typeof content === "string" ? content : (content ?? []).map(p => p?.text ?? "").join("");
      const reply = (replies[answered++] ?? "<<MOCK_REPLIES_EXHAUSTED>>")
        .replaceAll("{{input}}", input)
        .replace(/\{\{env:([A-Z_]+)\}\}/g, (_, name: string) => process.env[name] ?? "");
      writeLine({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
      writeLine({ type: "result", subtype: "success", session_id: "mock", is_error: false, result: reply });
    }
  });
  process.stdin.on("end", () => process.exit(0));
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
