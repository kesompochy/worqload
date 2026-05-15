// PoC: a SessionDriver implementation that drives interactive `claude` from
// inside a tmux session, so the work draws from interactive usage limits
// instead of the Agent SDK credit pool that `claude -p` will consume starting
// 2026-06-15. Output is read from claude's own JSONL transcript under
// ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl (same structure as
// stream-json), input is delivered via tmux's paste-buffer + Enter.
//
// Not yet a drop-in replacement for the pipe driver. Known PoC limits:
//   - Permission prompts. Assumes --dangerously-skip-permissions is honored
//     in the TUI. If a prompt does appear the session stalls until manually
//     dismissed.
//   - Transcript path discovery. Polls the projects dir for the new jsonl
//     after spawn; on resume this picks whatever is newest, which is right
//     only if no concurrent run is touching the same cwd.
//   - Backpressure. The tail loop reads the entire file each tick. Fine for
//     a PoC but not for very long sessions.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyClaudeLine } from "./claude-stream";
import type {
  SessionDriver,
  SessionDriverFactory,
  SessionDriverLaunchOptions,
} from "./session-driver";

// Claude Code stores transcripts at
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// where encoded-cwd is the absolute cwd with '/' replaced by '-'.
export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export function tmuxSessionName(sessionId: string): string {
  return `worqload-${sessionId.slice(0, 8)}`;
}

export interface TmuxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TmuxDriverDeps {
  // Runs a tmux command. The default invokes the system `tmux` binary via
  // Bun.spawn; tests inject a fake.
  tmuxRun: (args: string[], opts?: { stdin?: string }) => Promise<TmuxRunResult>;
  // Where to look for claude's JSONL transcripts for a given cwd.
  resolveTranscriptDir: (cwd: string) => string;
  // Polling cadence for the transcript-tail and has-session loops.
  pollIntervalMs: number;
  // How long to wait for claude to create the transcript JSONL after spawn.
  // claude only writes the file once it processes its first message, so 30s
  // gives plenty of slack for slow startup. If exceeded, the driver resolves
  // exited with non-zero.
  transcriptWaitTimeoutMs: number;
}

export const defaultTmuxDeps: TmuxDriverDeps = {
  async tmuxRun(args, opts) {
    const stdin = opts?.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin);
    const proc = Bun.spawn(["tmux", ...args], {
      stdin,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode: code ?? 0, stdout, stderr };
  },
  resolveTranscriptDir(cwd) {
    return join(homedir(), ".claude", "projects", encodeCwdForClaudeProjects(cwd));
  },
  pollIntervalMs: 250,
  transcriptWaitTimeoutMs: 30_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface JsonlSnapshot {
  // filename → mtimeMs
  files: Map<string, number>;
}

async function snapshotJsonl(dir: string): Promise<JsonlSnapshot> {
  const files = new Map<string, number>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { files };
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const st = await stat(join(dir, name));
      files.set(name, st.mtimeMs);
    } catch {
      // race with deletion
    }
  }
  return { files };
}

// Polls `dir` until a jsonl that is either new (absent from `before`) or
// touched after spawn appears. Returns null if `shouldStop` becomes true or
// the deadline elapses — the caller distinguishes the two via its own state.
async function waitForTranscript(
  dir: string,
  before: JsonlSnapshot,
  deps: TmuxDriverDeps,
  deadlineMs: number,
  shouldStop: () => boolean,
): Promise<string | null> {
  while (Date.now() < deadlineMs) {
    if (shouldStop()) return null;
    const now = await snapshotJsonl(dir);
    for (const [name, mtime] of now.files) {
      const prev = before.files.get(name);
      if (prev === undefined || mtime > prev) {
        return join(dir, name);
      }
    }
    await sleep(deps.pollIntervalMs);
  }
  return null;
}

// Tails `path` line-by-line until `shouldStop()` returns true. Each non-empty
// line is JSON-parsed and forwarded; unparseable lines are wrapped in a
// `{ type: "raw", raw: <line> }` envelope so they still appear downstream.
async function tailJsonl(
  path: string,
  deps: TmuxDriverDeps,
  shouldStop: () => boolean,
  onLine: (parsed: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  let offset = 0;
  let buf = "";
  while (!shouldStop()) {
    let data: string;
    try {
      data = await readFile(path, { encoding: "utf8" });
    } catch {
      await sleep(deps.pollIntervalMs);
      continue;
    }
    if (data.length > offset) {
      buf += data.slice(offset);
      offset = data.length;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim() === "") continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          parsed = { type: "raw", raw: line };
        }
        await onLine(parsed);
      }
    }
    await sleep(deps.pollIntervalMs);
  }
}

let pasteBufferCounter = 0;
function nextPasteBufferName(sessionName: string): string {
  pasteBufferCounter += 1;
  return `${sessionName}-${pasteBufferCounter}`;
}

export function makeTmuxClaudeDriverFactory(deps: TmuxDriverDeps): SessionDriverFactory {
  return async (opts: SessionDriverLaunchOptions): Promise<SessionDriver> => {
    const sessionId = opts.env.WORQLOAD_SESSION_ID ?? `anon-${Date.now()}`;
    const sessionName = tmuxSessionName(sessionId);
    const cwd = opts.cwd ?? process.cwd();
    const transcriptDir = deps.resolveTranscriptDir(cwd);

    // Snapshot the projects dir so we can pick out claude's new transcript
    // file once it appears.
    const before = await snapshotJsonl(transcriptDir);

    // Forward each env var into the tmux session.
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(opts.env)) {
      envArgs.push("-e", `${k}=${v}`);
    }

    const spawnRes = await deps.tmuxRun([
      "new-session", "-d",
      "-s", sessionName,
      "-c", cwd,
      ...envArgs,
      ...opts.spawnCommand,
    ]);
    if (spawnRes.exitCode !== 0) {
      throw new Error(`tmux new-session failed (${spawnRes.exitCode}): ${spawnRes.stderr.trim()}`);
    }
    opts.log("tmux_spawned", { sessionName, cwd, argv: opts.spawnCommand });

    let exitedFlag = false;
    let exitResolve!: (code: number) => void;
    const exitedPromise = new Promise<number>((r) => {
      exitResolve = r;
    });
    const resolveExit = (code: number): void => {
      if (exitedFlag) return;
      exitedFlag = true;
      exitResolve(code);
    };

    // Run transcript discovery and tailing in the background. Blocking the
    // factory here would delay runHost's unix listen() past serve's connect
    // timeout (claude only writes the transcript after it processes its
    // first message, which we cannot send until the factory has returned).
    // If discovery never finds a transcript the session is effectively dead,
    // so resolve exited with a non-zero code so runHost marks it as crashed.
    const tailTask = (async () => {
      const transcriptPath = await waitForTranscript(
        transcriptDir,
        before,
        deps,
        Date.now() + deps.transcriptWaitTimeoutMs,
        () => exitedFlag,
      );
      if (transcriptPath === null) {
        // Either kill arrived first (exitedFlag set) or we hit the deadline.
        // Only the latter is a failure worth surfacing.
        if (!exitedFlag) {
          opts.log("transcript_discovery_failed", { transcriptDir, timeoutMs: deps.transcriptWaitTimeoutMs });
          resolveExit(1);
        }
        return;
      }
      opts.log("transcript_attached", { transcriptPath });
      await tailJsonl(
        transcriptPath,
        deps,
        () => exitedFlag,
        async (parsed) => {
          await opts.onEvent({ kind: classifyClaudeLine(parsed), payload: parsed });
        },
      );
    })();

    // Background loop: notice when the tmux session disappears (claude
    // exited on its own).
    void (async () => {
      while (!exitedFlag) {
        await sleep(deps.pollIntervalMs);
        if (exitedFlag) break;
        const res = await deps.tmuxRun(["has-session", "-t", sessionName]);
        if (res.exitCode !== 0) {
          opts.log("tmux_session_gone", { sessionName });
          resolveExit(0);
          break;
        }
      }
    })();

    return {
      async sendUserMessage(text, source) {
        const bufName = nextPasteBufferName(sessionName);
        const start = Date.now();
        try {
          await deps.tmuxRun(["load-buffer", "-b", bufName, "-"], { stdin: text });
          await deps.tmuxRun(["paste-buffer", "-d", "-b", bufName, "-t", sessionName]);
          await deps.tmuxRun(["send-keys", "-t", sessionName, "Enter"]);
          opts.log("tmux_send_user_message", {
            ok: true,
            durationMs: Date.now() - start,
            source,
            bytes: text.length,
          });
        } catch (err) {
          opts.log("tmux_send_user_message", {
            ok: false,
            durationMs: Date.now() - start,
            source,
            error: String(err),
          });
        }
      },
      kill(signal) {
        // tmux's kill-session has no distinction between graceful and
        // immediate teardown. We log the requested signal for diagnostics and
        // unconditionally tear the session down.
        opts.log("tmux_kill", { signal, sessionName });
        void deps.tmuxRun(["kill-session", "-t", sessionName]).then(() => {
          resolveExit(0);
        });
      },
      exited: (async () => {
        const code = await exitedPromise;
        await tailTask;
        return code;
      })(),
    };
  };
}

export const tmuxClaudeDriver: SessionDriverFactory = makeTmuxClaudeDriverFactory(defaultTmuxDeps);
