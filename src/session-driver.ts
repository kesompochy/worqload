// Abstraction over "how the host talks to claude". Today's only implementation
// is claudePipeDriver: spawn `claude -p` with stream-json on stdin/stdout. A
// second implementation (interactive claude driven via tmux) is the reason this
// indirection exists — runHost should be the same code in either case.

import { classifyClaudeLine, isClaudePipeTurnEnd, readLines } from "./claude-stream";
import type { EventKind } from "./event-log";
import { buildUserMessage } from "./session-bootstrap";

export interface SessionDriverEvent {
  kind: EventKind;
  payload: Record<string, unknown>;
}

// Part of the driver contract: every driver MUST emit one of these — kind
// "turn_completed" — each time its agent finishes responding to a user message
// (right after the classified events of that turn). Detecting the turn boundary
// is wire-format-specific and so is the driver's responsibility; emitting this
// normalized event lets consumers (the report-less auto-nudge) react without
// knowing any driver's stream shape. See each driver for its terminator.
export const TURN_COMPLETED_EVENT: SessionDriverEvent = { kind: "turn_completed", payload: {} };

export type SessionDriverEventSink = (event: SessionDriverEvent) => Promise<void> | void;

// A driver's wire format reduces to two per-line decisions: how to classify a
// transcript line into an EventKind, and whether the line closes a turn. The
// rest of the line→event pipeline (emit the classified event, then emit the
// normalized TURN_COMPLETED_EVENT on a boundary) is identical across drivers,
// so it lives in emitAgentLine rather than being copy-pasted — which is what
// let the codex driver silently omit the turn-end emit before turn_completed
// was normalized. classify/isTurnEnd accept Record<string, unknown> so the
// per-wire predicates (which read only their own optional fields) plug in
// directly.
export interface AgentLineFormat {
  classify: (parsed: Record<string, unknown>) => EventKind;
  isTurnEnd: (parsed: Record<string, unknown>) => boolean;
}

// Parse one transcript line, falling back to a raw envelope so an unparseable
// line still surfaces downstream (classified as claude_system) instead of being
// dropped.
export function parseAgentLine(line: string): Record<string, unknown> {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { type: "raw", raw: line };
  }
}

// Emit the normalized events for one already-parsed transcript line: the
// classified agent event, then TURN_COMPLETED_EVENT when the line closes a
// turn. Drivers that inspect the parsed line for their own bookkeeping (codex's
// thread-id capture) do so before calling this.
export async function emitAgentLine(
  parsed: Record<string, unknown>,
  format: AgentLineFormat,
  onEvent: SessionDriverEventSink,
): Promise<void> {
  await onEvent({ kind: format.classify(parsed), payload: parsed });
  if (format.isTurnEnd(parsed)) await onEvent(TURN_COMPLETED_EVENT);
}

// A driver's stderr is uniformly surfaced as a claude_system stderr event.
export function emitStderrLine(line: string, onEvent: SessionDriverEventSink): Promise<void> | void {
  return onEvent({ kind: "claude_system", payload: { type: "stderr", text: line } });
}

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
// The stream-json `result` line is this driver's authoritative turn boundary.
const CLAUDE_PIPE_FORMAT: AgentLineFormat = {
  classify: classifyClaudeLine,
  isTurnEnd: isClaudePipeTurnEnd,
};

export const claudePipeDriver: SessionDriverFactory = async (opts) => {
  const claude = Bun.spawn(opts.spawnCommand, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutTask = readLines(claude.stdout, (line) =>
    emitAgentLine(parseAgentLine(line), CLAUDE_PIPE_FORMAT, opts.onEvent),
  );

  const stderrTask = readLines(claude.stderr, (line) => emitStderrLine(line, opts.onEvent));

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
