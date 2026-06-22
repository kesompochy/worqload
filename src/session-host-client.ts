import type { Socket, Subprocess } from "bun";
import type { Event } from "./event-log";
import {
  BackpressuredWriter,
  encodeMessage,
  type HostToServeMessage,
  parseLineDelimited,
  type ServeToHostMessage,
} from "./session-host-protocol";

export interface SpawnHostOptions {
  sessionId: string;
  sessionsDir: string;
  socketPath: string;
  // Endpoint the agent-side CLI (`worqload report` etc.) talks to, i.e. this
  // serve instance's base URL. The host puts it in claude's environment as
  // WORQLOAD_ENDPOINT.
  agentEndpoint: string;
  // The claude command the host will spawn, as separate argv elements (some
  // contain spaces, e.g. --allowedTools' value).
  spawnCommand: string[];
  // How to launch the host process itself. In production this is the
  // installed `worqload` CLI followed by `session-host`. Tests pass
  // ["bun", "<repo>/src/cli.ts", "session-host"] to run the local code.
  hostCommand: string[];
  // Resume mode: the host emits session_resumed (not session_started) and
  // sends RESUME_KICKOFF instead of the protocol bootstrap. The caller is
  // expected to have appended `--continue` to spawnCommand.
  resume?: boolean;
  // JSONL file the host appends diagnostic entries to (wake forwarding,
  // claude.stdin write outcomes). Unset → host logs to its stderr, which the
  // detached spawn discards.
  logFile?: string;
  // Driver name passed through as `--driver <name>` to the host. The host
  // resolves it to a SessionDriverFactory at parse time. Unset → host uses
  // its default (the pipe driver speaking stream-json to `claude -p`).
  agentName?: "claude" | "codex" | "cursor";
  driverName?: "pipe" | "tmux";
}

export function buildHostArgv(opts: SpawnHostOptions): string[] {
  return [
    ...opts.hostCommand,
    opts.sessionId,
    "--sessions-dir",
    opts.sessionsDir,
    "--socket-path",
    opts.socketPath,
    "--agent-endpoint",
    opts.agentEndpoint,
    ...(opts.resume ? ["--resume"] : []),
    ...(opts.logFile !== undefined ? ["--log-file", opts.logFile] : []),
    ...(opts.agentName !== undefined ? ["--agent", opts.agentName] : []),
    ...(opts.driverName !== undefined ? ["--driver", opts.driverName] : []),
    "--",
    ...opts.spawnCommand,
  ];
}

export function spawnDetachedHost(opts: SpawnHostOptions): Subprocess {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  const child = Bun.spawn(buildHostArgv(opts), {
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  return child;
}

export interface ConnectOptions {
  socketPath: string;
  sinceSeq?: number;
  onEvent?: (event: Event) => void;
  onDisconnect?: () => void;
  // Maximum time spent waiting for the host's socket to appear before giving
  // up. Default 5s — plenty for a fresh spawn, fast enough that a missing
  // host doesn't deadlock the caller.
  connectTimeoutMs?: number;
}

export interface HostClient {
  send(text: string): Promise<void>;
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  close(): Promise<void>;
  // Resolves after the host finished replaying past events and is now feeding
  // live updates. Rejects if the host disconnects before replay completes.
  replayCompleted: Promise<{ lastSeq: number }>;
  // Resolves with the claude exit code once the host announces termination.
  exited: Promise<number | null>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

export async function connectToHost(opts: ConnectOptions): Promise<HostClient> {
  const sinceSeq = opts.sinceSeq ?? 0;
  const deadline = Date.now() + (opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

  let buf = "";
  let replayResolve!: (val: { lastSeq: number }) => void;
  let replayReject!: (err: unknown) => void;
  const replayCompleted = new Promise<{ lastSeq: number }>((res, rej) => {
    replayResolve = res;
    replayReject = rej;
  });
  let replayDone = false;

  let exitResolve!: (code: number | null) => void;
  const exited = new Promise<number | null>((res) => {
    exitResolve = res;
  });
  let hasExited = false;

  const handleMessage = (msg: HostToServeMessage): void => {
    switch (msg.type) {
      case "event":
        opts.onEvent?.(msg.event);
        return;
      case "replay_done":
        replayDone = true;
        replayResolve({ lastSeq: msg.lastSeq });
        return;
      case "exited":
        hasExited = true;
        exitResolve(msg.code);
        return;
      case "ready":
        // pre-handshake heartbeat; nothing actionable yet
        return;
    }
  };

  let socket: Socket<undefined> | null = null;
  // Buffers any tail the socket couldn't take in one write and resends it on
  // `drain`; assigned once the socket connects (below).
  let writer: BackpressuredWriter | null = null;
  // The first call to Bun.connect may race with the host's listen() — retry
  // until the socket exists or we hit the timeout.
  while (true) {
    try {
      socket = await Bun.connect<undefined>({
        unix: opts.socketPath,
        socket: {
          open() {},
          data(_s, chunk) {
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            const { messages, buffer } = parseLineDelimited<HostToServeMessage>(text, buf);
            buf = buffer;
            for (const m of messages) handleMessage(m);
          },
          drain() {
            writer?.flush();
          },
          close() {
            if (!hasExited) {
              exitResolve(null);
              hasExited = true;
            }
            if (!replayDone) {
              replayReject(new Error("host disconnected before replay completed"));
              replayDone = true;
            }
            opts.onDisconnect?.();
          },
          error(_s, err) {
            console.error("session-host-client: socket error", err);
          },
        },
      });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw err;
      if (Date.now() >= deadline) {
        throw new Error(`timed out connecting to host socket at ${opts.socketPath}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!socket) throw new Error("unreachable");
  const connected = socket;
  writer = new BackpressuredWriter({ write: (bytes) => connected.write(bytes) });

  const write = (msg: ServeToHostMessage): void => {
    try {
      writer?.send(encodeMessage(msg));
    } catch {
      // socket dead; the close handler will fire shortly
    }
  };

  // Initiate the handshake. The host will emit a stream of past events
  // followed by replay_done.
  write({ type: "hello", sinceSeq });

  return {
    async send(text: string) {
      write({ type: "send_user", text });
    },
    async kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
      write({ type: "kill", signal });
    },
    async close() {
      try {
        socket?.end();
      } catch {
        // already closed
      }
    },
    replayCompleted,
    exited,
  };
}
