import type { Subprocess } from "bun";
import { appendEvent } from "./event-log";
import type { Event, EventKind } from "./event-log";

export interface RunnerOptions {
  sessionId: string;
  sessionsDir?: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  onEvent?: (event: Event) => void;
}

export interface SessionRunner {
  pid: number;
  exited: Promise<number>;
  send(message: unknown): Promise<void>;
  closeStdin(): Promise<void>;
  kill(signal?: NodeJS.Signals | number): void;
}

interface ParsedClaudeLine {
  type?: string;
  message?: { content?: unknown };
  [key: string]: unknown;
}

function classifyClaudeLine(parsed: ParsedClaudeLine): EventKind {
  const type = parsed?.type;
  const content = parsed?.message?.content;
  const blocks = Array.isArray(content) ? content : null;

  switch (type) {
    case "assistant":
      if (blocks?.some(b => (b as { type?: string })?.type === "tool_use")) {
        return "claude_tool_use";
      }
      return "claude_assistant_message";
    case "user":
      if (blocks?.some(b => (b as { type?: string })?.type === "tool_result")) {
        return "claude_tool_result";
      }
      return "claude_system";
    case "system":
    case "result":
    default:
      return "claude_system";
  }
}

async function readLines(
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

export function startSessionRunner(options: RunnerOptions): SessionRunner {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...options.env })) {
    if (typeof v === "string") env[k] = v;
  }

  const proc: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn(options.command, {
    cwd: options.cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutTask = readLines(proc.stdout, async line => {
    let parsed: ParsedClaudeLine;
    try {
      parsed = JSON.parse(line) as ParsedClaudeLine;
    } catch {
      parsed = { type: "raw", raw: line } as ParsedClaudeLine;
    }
    const kind = classifyClaudeLine(parsed);
    let event;
    try {
      event = await appendEvent(
        options.sessionId,
        { kind, payload: parsed },
        options.sessionsDir,
      );
    } catch {
      return; // session dir gone (cancelled / cleanup)
    }
    options.onEvent?.(event);
  });

  const stderrTask = readLines(proc.stderr, async line => {
    let event;
    try {
      event = await appendEvent(
        options.sessionId,
        { kind: "claude_system", payload: { type: "stderr", text: line } },
        options.sessionsDir,
      );
    } catch {
      return;
    }
    options.onEvent?.(event);
  });

  const exited = (async () => {
    const code = await proc.exited;
    // wait for stdio drain
    await Promise.allSettled([stdoutTask, stderrTask]);
    if (code !== 0) {
      try {
        const event = await appendEvent(
          options.sessionId,
          { kind: "session_crashed", payload: { exitCode: code } },
          options.sessionsDir,
        );
        options.onEvent?.(event);
      } catch {
        // session dir may be gone
      }
    }
    return code;
  })();

  const writer = proc.stdin;

  return {
    pid: proc.pid,
    exited,
    async send(message: unknown) {
      const line = `${JSON.stringify(message)}\n`;
      writer.write(line);
      await writer.flush();
    },
    async closeStdin() {
      writer.end();
    },
    kill(signal: NodeJS.Signals | number = "SIGTERM") {
      proc.kill(signal as never);
    },
  };
}
