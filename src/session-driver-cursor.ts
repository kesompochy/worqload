// Cursor Agent CLI equivalent of codexPipeDriver. `agent -p` is one prompt
// then exit — multi-turn requires `--resume <session_id>` per follow-up. This
// driver hides that behind the SessionDriver contract by spawning a fresh agent
// per sendUserMessage, capturing session_id from the JSONL stream, and reusing
// it for subsequent invocations.

import { readLines } from "./claude-stream";
import { classifyCursorLine, extractCursorSessionId } from "./cursor-stream";
import type {
  SessionDriver,
  SessionDriverFactory,
  SessionDriverLaunchOptions,
} from "./session-driver";

export const cursorPipeDriver: SessionDriverFactory = async (
  opts: SessionDriverLaunchOptions,
): Promise<SessionDriver> => {
  let sessionId: string | null = opts.priorAgentSessionId ?? null;
  let currentProc: ReturnType<typeof Bun.spawn> | null = null;
  let killed = false;
  let exitResolve!: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    exitResolve = r;
  });

  let chain: Promise<void> = Promise.resolve();

  const runOneTurn = async (text: string, source: "bootstrap" | "send_user"): Promise<void> => {
    if (killed) return;
    const turnArgs = sessionId === null
      ? [text]
      : ["--resume", sessionId, text];
    const argv = [...opts.spawnCommand, ...turnArgs];
    const start = Date.now();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, {
        cwd: opts.cwd,
        env: opts.env,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      opts.log("cursor_spawn_failed", { source, error: String(err) });
      return;
    }
    currentProc = proc;

    const stdoutTask = readLines(proc.stdout, async (line) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parsed = { type: "raw", raw: line };
      }
      const id = extractCursorSessionId(parsed);
      if (id !== null && id !== sessionId) {
        sessionId = id;
        opts.onAgentSessionId?.(id);
      }
      await opts.onEvent({ kind: classifyCursorLine(parsed), payload: parsed });
    });
    const stderrTask = readLines(proc.stderr, async (line) => {
      await opts.onEvent({ kind: "claude_system", payload: { type: "stderr", text: line } });
    });

    const code = await proc.exited;
    await Promise.allSettled([stdoutTask, stderrTask]);
    opts.log("cursor_turn_complete", { source, durationMs: Date.now() - start, exitCode: code });
    if (currentProc === proc) currentProc = null;
  };

  return {
    async sendUserMessage(text, source) {
      const task = chain.then(() => runOneTurn(text, source));
      chain = task.catch(() => {});
      await task;
    },
    kill(_signal) {
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
