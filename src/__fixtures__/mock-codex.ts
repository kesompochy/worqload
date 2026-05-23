#!/usr/bin/env bun
// A test stand-in for `codex exec --json -` and `codex exec --json resume <id> -`.
// Emits codex-style JSONL events to stdout and exits when stdin closes (codex's
// real exec is one prompt → exit; we mimic that lifecycle exactly).
//
// argv layout: the test passes `[bun, mock-codex, <mode>, ...<sayArgs>]` as the
// spawnCommand prefix; the driver / rewriter appends `exec --json -` (fresh) or
// `exec --json resume <id> -` (resume). So process.argv looks like:
//   bun mock-codex.ts echo            exec --json -
//   bun mock-codex.ts echo            exec --json resume <id> -
//   bun mock-codex.ts say <TEXT>      exec --json -
//
// Modes:
//   echo   : echo the stdin text back as one agent_message item, then exit 0
//   say    : emit argv[3] verbatim as the agent_message item text, then exit 0
//            (used by the rewriter test to feed an exact transformed output)
//   crash  : emit thread.started and exit 1 immediately
//   hang   : emit thread.started, never write anything else, read stdin forever

const mode = process.argv[2] ?? "echo";
const sayText = process.argv[3] ?? "";

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function findResumeId(): string | null {
  const argv = process.argv.slice(2);
  const resumeIdx = argv.indexOf("resume");
  if (resumeIdx === -1) return null;
  return argv[resumeIdx + 1] ?? null;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  let total = 0;
  for (const c of chunks) total += c.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(buf);
}

const threadId = findResumeId() ?? `mock-thread-${process.pid}`;
writeLine({ type: "thread.started", thread_id: threadId });

if (mode === "crash") {
  process.exit(1);
}

if (mode === "hang") {
  process.stdin.on("data", () => {});
  setInterval(() => {}, 1_000_000);
}

if (mode === "say") {
  // Drain stdin (callers write to it) so the pipe doesn't fill; the canned
  // output below is independent of the actual prompt.
  await readStdin();
  writeLine({ type: "turn.started" });
  writeLine({
    type: "item.completed",
    item: { id: "i1", type: "agent_message", text: sayText },
  });
  writeLine({
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
  });
  process.exit(0);
}

if (mode === "echo") {
  const text = await readStdin();
  writeLine({ type: "turn.started" });
  writeLine({
    type: "item.completed",
    item: { id: "i1", type: "agent_message", text: `echo: ${text}` },
  });
  writeLine({
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
  });
  process.exit(0);
}
