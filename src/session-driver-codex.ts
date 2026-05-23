// Codex equivalent of claudePipeDriver. The two CLIs differ in lifecycle:
// `claude -p --input-format stream-json` keeps stdin open and processes
// many user messages in one process, but `codex exec` is one-prompt-then-exit
// — multi-turn requires `codex exec resume <thread_id>` per follow-up. This
// driver hides that asymmetry behind the SessionDriver contract by spawning a
// fresh codex per sendUserMessage, capturing the thread_id from the first
// `thread.started` event, and reusing it for subsequent invocations.

import { readLines } from "./claude-stream";
import { classifyCodexLine, extractCodexThreadId } from "./codex-stream";
import type {
  SessionDriver,
  SessionDriverFactory,
  SessionDriverLaunchOptions,
} from "./session-driver";

// `opts.spawnCommand` is the codex binary prefix (e.g. ["codex"] or
// ["codex", "--config", "foo"]). The driver appends `exec --json -` (fresh) or
// `exec resume --json <thread_id> -` (subsequent) and feeds the user text on
// stdin — codex reads from stdin when `-` is the prompt placeholder.
export const codexPipeDriver: SessionDriverFactory = async (
  opts: SessionDriverLaunchOptions,
): Promise<SessionDriver> => {
  // Seed with the prior id from worqload meta (set when a previous host
  // captured it). Means the very first sendUserMessage in a resumed host
  // hits `codex exec --json resume <prior_id> -` instead of starting a fresh
  // thread codex has no memory of.
  let threadId: string | null = opts.priorAgentSessionId ?? null;
  let currentProc: ReturnType<typeof Bun.spawn> | null = null;
  let killed = false;
  let exitResolve!: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    exitResolve = r;
  });

  // Per-turn process spawn means a second sendUserMessage that arrives while
  // the first is still running would race to start its own codex on the same
  // thread. We serialize through a single tail-of-chain promise so the second
  // turn only starts after the first finishes (and after threadId is set).
  let chain: Promise<void> = Promise.resolve();

  const runOneTurn = async (text: string, source: "bootstrap" | "send_user"): Promise<void> => {
    if (killed) return;
    const turnArgs = threadId === null
      ? ["exec", "--json", "-"]
      : ["exec", "--json", "resume", threadId, "-"];
    const argv = [...opts.spawnCommand, ...turnArgs];
    const start = Date.now();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, {
        cwd: opts.cwd,
        env: opts.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      opts.log("codex_spawn_failed", { source, error: String(err) });
      return;
    }
    currentProc = proc;

    try {
      proc.stdin.write(text);
      await proc.stdin.flush();
      proc.stdin.end();
      opts.log("codex_stdin_write", { ok: true, source, durationMs: Date.now() - start });
    } catch (err) {
      opts.log("codex_stdin_write", { ok: false, source, error: String(err) });
      // Codex may still emit useful output (e.g. a startup error); fall through
      // to drain stdout/stderr so onEvent gets it.
    }

    const stdoutTask = readLines(proc.stdout, async (line) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parsed = { type: "raw", raw: line };
      }
      const id = extractCodexThreadId(parsed);
      // Fire onAgentSessionId whenever the id we see differs from what we
      // have on record. Two reasons it can change: first capture (threadId
      // was null), or codex rotated us off an expired thread (returned a new
      // id even though we asked to resume an old one).
      if (id !== null && id !== threadId) {
        threadId = id;
        opts.onAgentSessionId?.(id);
      }
      await opts.onEvent({ kind: classifyCodexLine(parsed), payload: parsed });
    });
    const stderrTask = readLines(proc.stderr, async (line) => {
      await opts.onEvent({ kind: "claude_system", payload: { type: "stderr", text: line } });
    });

    const code = await proc.exited;
    await Promise.allSettled([stdoutTask, stderrTask]);
    opts.log("codex_turn_complete", { source, durationMs: Date.now() - start, exitCode: code });
    if (currentProc === proc) currentProc = null;
  };

  return {
    async sendUserMessage(text, source) {
      const task = chain.then(() => runOneTurn(text, source));
      // Swallow rejections on the stored tail so a failed turn does not
      // poison every turn queued behind it.
      chain = task.catch(() => {});
      await task;
    },
    kill(_signal) {
      // No graceful-vs-immediate distinction: codex's per-turn lifecycle means
      // SIGTERM and SIGKILL behave the same for us. We always SIGKILL the
      // current child so a wedged process can't outlive the session.
      killed = true;
      if (currentProc) {
        try {
          currentProc.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
      exitResolve(0);
    },
    exited: exitedPromise,
  };
};
