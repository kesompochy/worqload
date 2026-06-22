import type { Socket } from "bun";
import { appendFileSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { appendEvent, readEvents } from "../event-log";
import { exitWithUsage } from "./cli-helpers";
import { buildProtocolPrefix, RESUME_KICKOFF } from "../session-bootstrap";
import { agentEndpointPath, loadSessionMeta, saveSessionMeta } from "../session";
import { claudePipeDriver, type SessionDriver, type SessionDriverFactory } from "../session-driver";
import { codexPipeDriver } from "../session-driver-codex";
import { tmuxClaudeDriver } from "../session-driver-tmux";
import {
  BackpressuredWriter,
  encodeMessage,
  type HostToServeMessage,
  parseLineDelimited,
  type ServeToHostMessage,
} from "../session-host-protocol";

export function resolveDriverFactory(agentName: string, driverName: string): SessionDriverFactory {
  if (agentName === "codex") {
    switch (driverName) {
      case "pipe":
        return codexPipeDriver;
      default:
        throw new Error(`unsupported driver '${driverName}' for agent 'codex' (expected 'pipe')`);
    }
  }
  switch (driverName) {
    case "pipe":
      return claudePipeDriver;
    case "tmux":
      return tmuxClaudeDriver;
    default:
      throw new Error(`unknown WORQLOAD_DRIVER: ${driverName} (expected 'pipe' or 'tmux')`);
  }
}

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
  // JSONL file to append structured diagnostic entries to (wake forwarding,
  // claude.stdin write outcomes, etc). Falls back to process.stderr when unset
  // so tests don't litter the filesystem.
  logFile?: string;
  // Driver factory used to spawn the claude session. Defaults to
  // `claudePipeDriver` (a child process speaking stream-json over stdio).
  // Tests inject a fake driver to bypass the real spawn; future drivers
  // (e.g. tmux-interactive) will plug in here.
  driver?: SessionDriverFactory;
}

type LogFn = (event: string, fields?: Record<string, unknown>) => void;

function makeHostLogger(logFile: string | undefined): LogFn {
  if (!logFile) return () => {};
  return (event, fields = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), source: "host", event, ...fields }) + "\n";
    try {
      appendFileSync(logFile, line);
    } catch {
      // diagnostic logging is best-effort; never throw
    }
  };
}

// Cap the body preview so a giant resume kickoff or feedback file doesn't
// bloat the log file. The full text still reaches claude — only the diagnostic
// echo is trimmed.
const LOG_PREVIEW_MAX = 200;
function previewText(text: string): string {
  if (text.length <= LOG_PREVIEW_MAX) return text;
  return `${text.slice(0, LOG_PREVIEW_MAX)}…(+${text.length - LOG_PREVIEW_MAX} chars)`;
}

interface ClientState {
  buf: string;
  writer: BackpressuredWriter;
}

// In-process entrypoint. Returns once the hosted claude has exited and the
// socket has been cleaned up. The caller (CLI wrapper or test) decides what
// to do with the resolved exit code.
export async function runHost(opts: HostOptions): Promise<number> {
  const log = makeHostLogger(opts.logFile);

  const meta = await loadSessionMeta(opts.sessionId, opts.sessionsDir);
  if (!meta) throw new Error(`session not found: ${opts.sessionId}`);

  log("host_started", {
    sessionId: opts.sessionId,
    pid: process.pid,
    socketPath: opts.socketPath,
    resume: opts.resume === true,
  });

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

  const sendToActive = (msg: HostToServeMessage): void => {
    if (!activeClient) return;
    try {
      activeClient.data.writer.send(encodeMessage(msg));
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

  // Driver is created AFTER the listener is up so serve never sees a socket
  // timeout when driver setup is slow (e.g. tmux new-session) or throws
  // (e.g. tmux not on PATH). Mutable so handleServeMessage can guard against
  // messages arriving before the driver is ready.
  let driver: SessionDriver | undefined;

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
        if (!driver) {
          log("send_user_dropped_driver_not_ready", { textLen: msg.text.length });
          return;
        }
        log("send_user_received", { textLen: msg.text.length, preview: previewText(msg.text) });
        await driver.sendUserMessage(msg.text, "send_user");
        return;
      }
      case "kill": {
        if (!driver) {
          log("kill_before_driver_ready", { signal: msg.signal });
          return;
        }
        driver.kill(msg.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
        return;
      }
    }
  };

  const listener = Bun.listen<ClientState>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        socket.data = { buf: "", writer: new BackpressuredWriter({ write: (bytes) => socket.write(bytes) }) };
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
      drain(socket) {
        socket.data.writer.flush();
      },
      close(socket) {
        if (activeClient === socket) activeClient = null;
      },
    },
  });
  log("host_listening", { socketPath: opts.socketPath });

  // Mark the session as running before driver setup so the UI shows the
  // session even if driver init takes a while.
  await saveSessionMeta(
    { ...meta, hostPid: process.pid, hostSocketPath: opts.socketPath, status: "running" },
    opts.sessionsDir,
  );

  // Persist the agent-side conversation id whenever the driver captures or
  // rotates it. Reads fresh meta to avoid clobbering any field the user (or
  // serve) wrote between our last saveSessionMeta and now.
  const persistAgentSessionId = async (id: string): Promise<void> => {
    try {
      const fresh = await loadSessionMeta(opts.sessionId, opts.sessionsDir);
      if (!fresh) return;
      if (fresh.agentSessionId === id) return;
      await saveSessionMeta({ ...fresh, agentSessionId: id }, opts.sessionsDir);
      log("agent_session_id_persisted", { agentSessionId: id });
    } catch (err) {
      log("agent_session_id_persist_failed", { error: String(err) });
    }
  };

  try {
    const defaultDriver = resolveDriverFactory(meta.agentName ?? "claude", "pipe");
    driver = await (opts.driver ?? defaultDriver)({
      cwd: meta.worktreePath || undefined,
      env: claudeEnv,
      spawnCommand: opts.spawnCommand,
      resume: opts.resume === true,
      onEvent: (event) => writeEvent(event),
      log,
      ...(meta.agentSessionId !== undefined && { priorAgentSessionId: meta.agentSessionId }),
      onAgentSessionId: (id) => { void persistAgentSessionId(id); },
    });
  } catch (err) {
    // The detached host's stderr is /dev/null, so an exception thrown from
    // the driver factory would otherwise vanish. Surface it: persist the
    // cause in host.log AND mark the session crashed so the UI shows it
    // instead of an idle "running" row.
    const errorMessage = err instanceof Error ? err.message : String(err);
    log("driver_factory_failed", { error: errorMessage });
    await writeEvent({
      kind: "session_crashed",
      payload: { reason: "driver_factory_failed", error: errorMessage },
    });
    const final = await loadSessionMeta(opts.sessionId, opts.sessionsDir);
    if (final) {
      await saveSessionMeta(
        { ...final, status: "crashed", endedAt: new Date().toISOString() },
        opts.sessionsDir,
      );
    }
    // serve's connectToHost polls the socket every 50ms with a 5s timeout.
    // Driver failures here can resolve in well under that — if we tear the
    // listener down immediately, serve misses the existence window and
    // surfaces a "timed out connecting to host socket" 500 instead of the
    // crash we just persisted. Hold the listener open until either a client
    // attaches or a generous deadline elapses; once attached, send `exited`
    // so the connection unwinds cleanly.
    const giveUpAt = Date.now() + 10_000;
    while (!activeClient && Date.now() < giveUpAt) {
      await new Promise((r) => setTimeout(r, 50));
    }
    sendToActive({ type: "exited", code: 1 });
    await new Promise((r) => setTimeout(r, 100));
    listener.stop(true);
    try {
      await unlink(opts.socketPath);
    } catch {
      // socket already gone
    }
    return 1;
  }

  await writeEvent({
    kind: opts.resume ? "session_resumed" : "session_started",
    payload: { prompt: meta.prompt },
  });

  // First message. On a fresh start the agent learns the protocol from
  // the protocol prefix and the task from meta.prompt. On resume the prior
  // conversation is restored by `claude --continue`, so we only nudge it back
  // into the loop (any new instruction was queued to the feedback inbox).
  const firstMessage = opts.resume ? RESUME_KICKOFF : buildProtocolPrefix(meta.baseBranch) + meta.prompt;
  log("bootstrap_send", { textLen: firstMessage.length, resume: opts.resume === true });
  await driver.sendUserMessage(firstMessage, "bootstrap");

  const exitCode = await driver.exited;
  log("claude_exited", { exitCode });

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
  "worqload session-host <sessionId> --sessions-dir <dir> --socket-path <path> --agent-endpoint <url> [--resume] [--log-file <path>] [--agent claude|codex] [--driver pipe|tmux] -- <command...>";

// Splits the host CLI argv. Layout is `<sessionId> --flag value ... -- <command...>`.
// Everything after the literal `--` is the agent spawn command verbatim (its
// args may contain spaces); the sessionId is the leading positional.
export function parseHostArgs(args: string[]): HostOptions | null {
  const sep = args.indexOf("--");
  const head = sep === -1 ? args : args.slice(0, sep);
  const spawnCommand = sep === -1 ? [] : args.slice(sep + 1);

  const sessionId = head[0] && !head[0].startsWith("--") ? head[0] : undefined;
  const sessionsDir = takeFlag(head, "--sessions-dir");
  const socketPath = takeFlag(head, "--socket-path");
  const agentEndpoint = takeFlag(head, "--agent-endpoint");
  const logFile = takeFlag(head, "--log-file");
  const agentName = takeFlag(head, "--agent");
  const driverName = takeFlag(head, "--driver");
  const resume = head.includes("--resume");
  if (!sessionId || !sessionsDir || !socketPath || !agentEndpoint || spawnCommand.length === 0) {
    return null;
  }
  const driver = driverName
    ? resolveDriverFactory(agentName ?? "claude", driverName)
    : undefined;
  return {
    sessionId,
    sessionsDir,
    socketPath,
    agentEndpoint,
    spawnCommand,
    ...(resume && { resume }),
    ...(logFile !== undefined && { logFile }),
    ...(driver !== undefined && { driver }),
  };
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
