import type { Socket } from "bun";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { classifyClaudeLine, readLines } from "../claude-stream";
import { appendEvent, readEvents } from "../event-log";
import { exitWithUsage } from "./cli-helpers";
import { buildUserMessage, PROTOCOL_PREFIX, RESUME_KICKOFF } from "../session-bootstrap";
import { agentEndpointPath, loadSessionMeta, saveSessionMeta } from "../session";
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
  // Base URL of the serve instance, exposed to claude (and thus the agent
  // CLI) as WORQLOAD_ENDPOINT.
  agentEndpoint: string;
  spawnCommand: string[];
  // Resume mode: emit session_resumed instead of session_started and send
  // RESUME_KICKOFF as the first message instead of the protocol bootstrap.
  // spawnCommand is expected to already carry `--continue`.
  resume?: boolean;
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
  // The agent CLI inside claude needs these to reach serve's /internal routes.
  // WORQLOAD_ENDPOINT is the bootstrap-time fallback; WORQLOAD_ENDPOINT_FILE
  // points at the file serve keeps up to date so the agent follows serve
  // across a restart on a different port.
  claudeEnv.WORQLOAD_SESSION_ID = opts.sessionId;
  claudeEnv.WORQLOAD_ENDPOINT = opts.agentEndpoint;
  claudeEnv.WORQLOAD_ENDPOINT_FILE = agentEndpointPath(opts.sessionsDir, opts.sessionId);

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
      // session dir gone (cleanup): drop the event
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

  await writeEvent({
    kind: opts.resume ? "session_resumed" : "session_started",
    payload: { prompt: meta.prompt },
  });

  // First message. On a fresh start the agent learns the protocol from
  // PROTOCOL_PREFIX and the task from meta.prompt. On resume the prior
  // conversation is restored by `claude --continue`, so we only nudge it back
  // into the loop (any new instruction was queued to the feedback inbox).
  const firstMessage = opts.resume ? RESUME_KICKOFF : PROTOCOL_PREFIX + meta.prompt;
  try {
    claude.stdin.write(`${JSON.stringify(buildUserMessage(firstMessage))}\n`);
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

const HOST_USAGE =
  "worqload session-host <sessionId> --sessions-dir <dir> --socket-path <path> --agent-endpoint <url> [--resume] -- <claude command...>";

// Splits the host CLI argv. Layout is `<sessionId> --flag value ... -- <claude command...>`.
// Everything after the literal `--` is the claude spawn command verbatim (its
// args may contain spaces); the sessionId is the leading positional.
export function parseHostArgs(args: string[]): HostOptions | null {
  const sep = args.indexOf("--");
  const head = sep === -1 ? args : args.slice(0, sep);
  const spawnCommand = sep === -1 ? [] : args.slice(sep + 1);

  const sessionId = head[0] && !head[0].startsWith("--") ? head[0] : undefined;
  const sessionsDir = takeFlag(head, "--sessions-dir");
  const socketPath = takeFlag(head, "--socket-path");
  const agentEndpoint = takeFlag(head, "--agent-endpoint");
  const resume = head.includes("--resume");
  if (!sessionId || !sessionsDir || !socketPath || !agentEndpoint || spawnCommand.length === 0) {
    return null;
  }
  return { sessionId, sessionsDir, socketPath, agentEndpoint, spawnCommand, ...(resume && { resume }) };
}

export async function sessionHost(args: string[]): Promise<void> {
  const opts = parseHostArgs(args);
  if (!opts) exitWithUsage(HOST_USAGE);
  const code = await runHost(opts);
  process.exit(code);
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}
