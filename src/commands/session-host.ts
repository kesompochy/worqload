import type { Socket } from "bun";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { classifyClaudeLine, readLines } from "../claude-stream";
import { appendEvent, readEvents } from "../event-log";
import { exitWithUsage } from "./cli-helpers";
import { buildUserMessage, PROTOCOL_PREFIX } from "../session-bootstrap";
import { loadSessionMeta, saveSessionMeta } from "../session";
import {
  encodeMessage,
  type HostToServeMessage,
  parseLineDelimited,
  type ServeToHostMessage,
} from "../session-host-protocol";

export interface HostOptions {
  sessionId: string;
  sessionsDir: string;
  socketPath: string;
  spawnCommand: string[];
}

interface ClientState {
  buf: string;
}

// In-process entrypoint. Returns once the hosted claude has exited and the
// socket has been cleaned up. The caller (CLI wrapper or test) decides what
// to do with the resolved exit code.
export async function runHost(opts: HostOptions): Promise<number> {
  const meta = await loadSessionMeta(opts.sessionId, opts.sessionsDir);
  if (!meta) throw new Error(`session not found: ${opts.sessionId}`);

  await mkdir(dirname(opts.socketPath), { recursive: true });
  try {
    await unlink(opts.socketPath);
  } catch {
    // socket didn't exist; fine
  }

  // Only one client (one `worqload serve` instance) is meaningful at a time.
  // If a new client arrives we drop the previous connection.
  let activeClient: Socket<ClientState> | null = null;

  const claudeEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") claudeEnv[k] = v;
  }

  const claude = Bun.spawn(opts.spawnCommand, {
    cwd: meta.worktreePath || undefined,
    env: claudeEnv,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const sendToActive = (msg: HostToServeMessage): void => {
    if (!activeClient) return;
    try {
      activeClient.write(encodeMessage(msg));
    } catch {
      // dead socket; will surface via close()
    }
  };

  const writeEvent = async (
    partial: Parameters<typeof appendEvent>[1],
  ): Promise<void> => {
    try {
      const event = await appendEvent(opts.sessionId, partial, opts.sessionsDir);
      sendToActive({ type: "event", event });
    } catch {
      // session dir gone (cancelled / cleanup): drop the event
    }
  };

  const handleServeMessage = async (msg: ServeToHostMessage): Promise<void> => {
    switch (msg.type) {
      case "hello": {
        const events = await readEvents(opts.sessionId, msg.sinceSeq + 1, opts.sessionsDir);
        for (const ev of events) sendToActive({ type: "event", event: ev });
        const lastSeq = events.length > 0 ? events[events.length - 1].seq : msg.sinceSeq;
        sendToActive({ type: "replay_done", lastSeq });
        return;
      }
      case "send_user": {
        const line = `${JSON.stringify(buildUserMessage(msg.text))}\n`;
        try {
          claude.stdin.write(line);
          await claude.stdin.flush();
        } catch (err) {
          console.error("session-host: write to claude stdin failed:", err);
        }
        return;
      }
      case "kill": {
        try {
          claude.kill(msg.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
        } catch {
          // already dead
        }
        return;
      }
    }
  };

  const listener = Bun.listen<ClientState>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        socket.data = { buf: "" };
        if (activeClient && activeClient !== socket) {
          try {
            activeClient.end();
          } catch {
            // ignore
          }
        }
        activeClient = socket;
      },
      data(socket, chunk) {
        const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        const { messages, buffer } = parseLineDelimited<ServeToHostMessage>(text, socket.data.buf);
        socket.data.buf = buffer;
        for (const msg of messages) {
          void handleServeMessage(msg);
        }
      },
      close(socket) {
        if (activeClient === socket) activeClient = null;
      },
    },
  });

  await saveSessionMeta(
    { ...meta, hostPid: process.pid, hostSocketPath: opts.socketPath, status: "running" },
    opts.sessionsDir,
  );

  await writeEvent({ kind: "session_started", payload: { prompt: meta.prompt } });

  // Bootstrap: the agent learns the worqload protocol from PROTOCOL_PREFIX,
  // and meta.prompt carries the actual task.
  try {
    claude.stdin.write(`${JSON.stringify(buildUserMessage(PROTOCOL_PREFIX + meta.prompt))}\n`);
    await claude.stdin.flush();
  } catch (err) {
    console.error("session-host: initial bootstrap write failed:", err);
  }

  const stdoutTask = readLines(claude.stdout, async (line) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      parsed = { type: "raw", raw: line };
    }
    await writeEvent({ kind: classifyClaudeLine(parsed), payload: parsed });
  });

  const stderrTask = readLines(claude.stderr, async (line) => {
    await writeEvent({ kind: "claude_system", payload: { type: "stderr", text: line } });
  });

  const exitCode = await claude.exited;
  await Promise.allSettled([stdoutTask, stderrTask]);

  const final = await loadSessionMeta(opts.sessionId, opts.sessionsDir);
  const alreadyTerminal = final && (final.status === "stopped" || final.status === "crashed");

  // Only emit a terminal event if serve hasn't already done so (e.g. via the
  // user clicking Stop). This keeps the event log free of duplicates while
  // preserving the natural-exit signal on crashes.
  if (!alreadyTerminal && exitCode !== 0) {
    await writeEvent({ kind: "session_crashed", payload: { exitCode } });
  }
  if (final && !alreadyTerminal) {
    await saveSessionMeta(
      {
        ...final,
        status: exitCode === 0 ? "stopped" : "crashed",
        endedAt: new Date().toISOString(),
      },
      opts.sessionsDir,
    );
  }

  sendToActive({ type: "exited", code: exitCode });

  // Give the kernel a moment to flush the last writes to the client before we
  // tear down the socket. Without this we sometimes see the `exited` message
  // dropped on macOS.
  await new Promise((r) => setTimeout(r, 20));
  listener.stop(true);
  try {
    await unlink(opts.socketPath);
  } catch {
    // socket already gone
  }

  return exitCode ?? 0;
}

export async function sessionHost(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const sessionId = positional[0];
  if (!sessionId) exitWithUsage("worqload session-host <sessionId> --sessions-dir <dir> --socket-path <path>");

  const sessionsDir = takeFlag(args, "--sessions-dir");
  const socketPath = takeFlag(args, "--socket-path");
  if (!sessionsDir || !socketPath) {
    exitWithUsage("worqload session-host <sessionId> --sessions-dir <dir> --socket-path <path>");
  }

  const spawnEnv = process.env.WORQLOAD_SPAWN_COMMAND;
  if (!spawnEnv || spawnEnv.trim() === "") {
    console.error("session-host requires WORQLOAD_SPAWN_COMMAND to be set");
    process.exit(2);
  }
  const spawnCommand = spawnEnv.trim().split(/\s+/);

  const code = await runHost({ sessionId, sessionsDir, socketPath, spawnCommand });
  process.exit(code);
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}
