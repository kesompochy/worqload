// Abstraction over "how the host talks to claude". Today's only implementation
// is claudePipeDriver: spawn `claude -p` with stream-json on stdin/stdout. A
// second implementation (interactive claude driven via tmux) is the reason this
// indirection exists — runHost should be the same code in either case.

import { classifyClaudeLine, readLines } from "./claude-stream";
import type { EventKind } from "./event-log";
import { buildUserMessage } from "./session-bootstrap";

export interface SessionDriverEvent {
  kind: EventKind;
  payload: Record<string, unknown>;
}

export type SessionDriverEventSink = (event: SessionDriverEvent) => Promise<void> | void;

export type SessionDriverLogFn = (event: string, fields?: Record<string, unknown>) => void;

export interface SessionDriverLaunchOptions {
  cwd?: string;
  env: Record<string, string>;
  spawnCommand: string[];
  onEvent: SessionDriverEventSink;
  log: SessionDriverLogFn;
  // The agent-side session identifier persisted from a prior host (if any).
  // Codex uses this to resume its thread across host restarts; the claude pipe
  // and tmux drivers ignore it (claude resumes via `--continue` at argv level,
  // tmux via the worqload session id it already encodes).
  priorAgentSessionId?: string;
  // Fired when the driver captures (or rotates) the agent-side session
  // identifier the next host should restore from. runHost persists it on the
  // worqload meta so a future resume can rejoin the same thread.
  onAgentSessionId?: (id: string) => void;
}

export interface SessionDriver {
  // Hand a user message to claude. `source` tags the call site for diagnostic
  // logs (the bootstrap send right after launch vs. a runtime forward from a
  // serve client). The driver decides the wire format (stream-json line for
  // the pipe driver, typed pty input for a future tmux driver, ...).
  sendUserMessage(text: string, source: "bootstrap" | "send_user"): Promise<void>;
  // Best-effort termination signal. Driver-specific: pipe driver sends a real
  // signal to the subprocess; a tmux driver would tear down the tmux session.
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  // Resolves with the exit code once claude has finished AND the driver has
  // drained its event stream. The host treats this as the end-of-session
  // signal.
  readonly exited: Promise<number>;
}

export type SessionDriverFactory = (opts: SessionDriverLaunchOptions) => Promise<SessionDriver>;

// Default driver: a child process speaking the `claude -p` stream-json
// protocol. `opts.spawnCommand` is the argv to launch (e.g. `claude -p
// --input-format stream-json --output-format stream-json ...`).
export const claudePipeDriver: SessionDriverFactory = async (opts) => {
  const claude = Bun.spawn(opts.spawnCommand, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutTask = readLines(claude.stdout, async (line) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      parsed = { type: "raw", raw: line };
    }
    await opts.onEvent({ kind: classifyClaudeLine(parsed), payload: parsed });
  });

  const stderrTask = readLines(claude.stderr, async (line) => {
    await opts.onEvent({ kind: "claude_system", payload: { type: "stderr", text: line } });
  });

  // exited resolves only after the stdout/stderr drains complete; otherwise the
  // host could finish before the last assistant message has been persisted.
  const exited = (async () => {
    const code = await claude.exited;
    await Promise.allSettled([stdoutTask, stderrTask]);
    return code ?? 0;
  })();

  return {
    async sendUserMessage(text, source) {
      const line = `${JSON.stringify(buildUserMessage(text))}\n`;
      const start = Date.now();
      try {
        claude.stdin.write(line);
        await claude.stdin.flush();
        opts.log("stdin_write", { ok: true, durationMs: Date.now() - start, source });
      } catch (err) {
        opts.log("stdin_write", { ok: false, durationMs: Date.now() - start, source, error: String(err) });
      }
    },
    kill(signal) {
      try {
        claude.kill(signal);
      } catch {
        // already dead
      }
    },
    exited,
  };
};
