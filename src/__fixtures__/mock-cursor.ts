#!/usr/bin/env bun
// Test stand-in for `agent -p --output-format stream-json ... <prompt>`.
// Emits Cursor-style JSONL to stdout and exits after one turn.
//
// argv layout: tests pass `[bun, mock-cursor, <mode>, ...]` as spawnCommand;
// the driver appends optional `--resume <id>` and the prompt text. Example:
//   bun mock-cursor.ts echo -p --output-format stream-json --force --trust hello
//   bun mock-cursor.ts echo -p ... --resume prior-id-abc follow-up
//
// Modes: echo, say, rotate, crash, hang — same semantics as mock-codex.

const mode = process.argv[2] ?? "echo";
const sayText = process.argv[3] ?? "";

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function findResumeId(): string | null {
  const argv = process.argv.slice(2);
  const resumeIdx = argv.indexOf("--resume");
  if (resumeIdx === -1) return null;
  return argv[resumeIdx + 1] ?? null;
}

function findPrompt(): string {
  const argv = process.argv.slice(2);
  if (argv.length === 0) return "";
  return argv[argv.length - 1] ?? "";
}

const sessionId = mode === "rotate"
  ? `mock-session-${process.pid}`
  : (findResumeId() ?? `mock-session-${process.pid}`);

writeLine({ type: "system", subtype: "init", session_id: sessionId });

if (mode === "crash") {
  process.exit(1);
}

if (mode === "hang") {
  process.stdin.on("data", () => {});
  setInterval(() => {}, 1_000_000);
}

const prompt = mode === "say" ? "" : findPrompt();
if (mode !== "say") {
  writeLine({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    session_id: sessionId,
  });
}

if (mode === "say") {
  writeLine({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: sayText }] },
    session_id: sessionId,
  });
  writeLine({ type: "result", subtype: "success", session_id: sessionId, is_error: false });
  process.exit(0);
}

if (mode === "echo" || mode === "rotate") {
  writeLine({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: `echo: ${prompt}` }] },
    session_id: sessionId,
  });
  writeLine({ type: "result", subtype: "success", session_id: sessionId, is_error: false });
  process.exit(0);
}
