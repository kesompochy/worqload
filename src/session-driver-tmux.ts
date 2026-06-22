// PoC: a SessionDriver implementation that drives interactive `claude` from
// inside a tmux session, so the work draws from interactive usage limits
// instead of the Agent SDK credit pool that `claude -p` will consume starting
// 2026-06-15. Output is read from claude's own JSONL transcript at
// ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl (same structure as
// stream-json); the first message is delivered as claude's positional
// `[prompt]` argument (so we don't have to race claude's TUI initialization
// with tmux paste-buffer), and subsequent messages go via bracketed paste.
//
// Not yet a drop-in replacement for the pipe driver. Known PoC limits:
//   - Permission prompts. Assumes --dangerously-skip-permissions is honored
//     in the TUI. If a prompt does appear the session stalls until manually
//     dismissed.
//   - Subsequent-message timing. Paste-into-TUI only works once claude's
//     bracketed-paste mode is active; that's true by the time the first
//     message has been processed (because we know claude's TUI is running),
//     but the first user message is sent as a CLI arg specifically to dodge
//     the startup race.
//   - Backpressure. The tail loop reads the entire file each tick. Fine for
//     a PoC but not for very long sessions.

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { classifyClaudeLine } from "./claude-stream";
import type {
  SessionDriver,
  SessionDriverFactory,
  SessionDriverLaunchOptions,
} from "./session-driver";

// Claude Code stores transcripts at
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// where encoded-cwd is the absolute cwd with both '/' and '.' replaced by
// '-'. Verified against ~/.claude/projects/ on a real machine:
//   /Users/.../foo.bar/.worktrees/abc → -Users-...-foo-bar--worktrees-abc
// (note the double-dash where '/.' appears in the original path).
export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
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
  // The settings.json scopes (user, project, local) to harvest `permissions.ask`
  // rules from, in that order. Those rules are re-declared as deny so the
  // interactive TUI fails guarded commands fast instead of hanging on a prompt
  // (see harvestAskRules). Tests override this to stay hermetic.
  resolveSettingsFiles: (cwd: string) => string[];
  // Polling cadence for the transcript-tail and has-session loops.
  pollIntervalMs: number;
  // How long to wait for claude to create the transcript JSONL after spawn.
  // claude only writes the file once it processes its first message, so 30s
  // gives plenty of slack for slow startup. If exceeded, the driver resolves
  // exited with non-zero.
  transcriptWaitTimeoutMs: number;
  // Directory for the temp file we write the bootstrap text to before passing
  // it to claude via $(cat <file>). Defaults to the OS tmpdir.
  bootstrapFileDir: string;
}

export const defaultTmuxDeps: TmuxDriverDeps = {
  async tmuxRun(args, opts) {
    // tmux's `new-session` forks a server daemon that inherits the spawned
    // client's stdout/stderr file descriptors. If we pipe them and read until
    // EOF (the natural shape of `new Response(stream).text()`), the daemon
    // holds the write end open forever and the read never returns — the
    // client command's quick exit doesn't help us. We sacrifice tmux's
    // diagnostic stderr to avoid that hang; the exit code is enough for our
    // success/failure check, and a human can re-run the command manually if
    // they need to see what tmux said.
    const stdin = opts?.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin);
    const proc = Bun.spawn(["tmux", ...args], {
      stdin,
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return { exitCode: code ?? 0, stdout: "", stderr: "" };
  },
  resolveTranscriptDir(cwd) {
    return join(homedir(), ".claude", "projects", encodeCwdForClaudeProjects(cwd));
  },
  resolveSettingsFiles(cwd) {
    return [
      join(homedir(), ".claude", "settings.json"),
      join(cwd, ".claude", "settings.json"),
      join(cwd, ".claude", "settings.local.json"),
    ];
  },
  pollIntervalMs: 250,
  transcriptWaitTimeoutMs: 30_000,
  bootstrapFileDir: tmpdir(),
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Collect the `permissions.ask` patterns from the given settings files (user,
// project, local scopes), unioned and order-preserving. Interactive claude
// honors these ask rules even under --dangerously-skip-permissions, and a
// driven tmux session has no human to answer the resulting prompt, so it hangs
// forever. Re-declaring each ask pattern as a deny (deny outranks ask) makes
// the TUI fail the command fast instead of blocking. Missing or malformed files
// are skipped.
export async function harvestAskRules(settingsFiles: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const file of settingsFiles) {
    let parsed: { permissions?: { ask?: unknown } };
    try {
      parsed = JSON.parse(await readFile(file, { encoding: "utf8" }));
    } catch {
      continue;
    }
    const ask = parsed?.permissions?.ask;
    if (!Array.isArray(ask)) continue;
    for (const pattern of ask) {
      if (typeof pattern === "string" && !seen.has(pattern)) {
        seen.add(pattern);
        rules.push(pattern);
      }
    }
  }
  return rules;
}

// Wait for `path` to appear, then tail it line-by-line. Each non-empty line is
// JSON-parsed and forwarded; unparseable lines are wrapped in a `{ type: "raw",
// raw: <line> }` envelope so they still appear downstream.
async function tailJsonl(
  path: string,
  deps: TmuxDriverDeps,
  shouldStop: () => boolean,
  onLine: (parsed: Record<string, unknown>) => Promise<void>,
  initialOffset = 0,
): Promise<void> {
  let offset = initialOffset;
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

// Wrap a string for safe use inside a single-quoted shell argument. We use
// single quotes everywhere we construct shell commands to avoid metachar
// interpretation; the only escape needed is closing the quote, slipping in a
// backslash-escaped single quote, and reopening.
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// The claude argv runs with the bootstrap text as its positional [prompt],
// read via $(cat <file>) inside a single double-quoted positional so newlines
// and shell metachars in the bootstrap pass through unevaluated. `exec`
// replaces the bash wrapper so the tmux pane's process IS claude (kill-session
// and has-session then track claude directly).
function claudeTmuxBootstrapShellCommand(claudeArgv: string[], bootstrapFile: string): string {
  const claudePrefix = claudeArgv.map(shellSingleQuote).join(" ");
  const fileArg = shellSingleQuote(bootstrapFile);
  return `exec ${claudePrefix} "$(cat ${fileArg})"`;
}

// Concatenate the text blocks of a transcript `assistant` line, or null if the
// line is not an assistant turn carrying text (system/init, tool_use, user
// echo). Same message shape classifyClaudeLine reads.
function assistantLineText(parsed: Record<string, unknown>): string | null {
  if (parsed?.type !== "assistant") return null;
  const content = (parsed.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b): b is { type: string; text: string } =>
      (b as { type?: string })?.type === "text" && typeof (b as { text?: unknown })?.text === "string",
    )
    .map((b) => b.text)
    .join("");
  return text === "" ? null : text;
}

export function makeTmuxClaudeDriverFactory(deps: TmuxDriverDeps): SessionDriverFactory {
  return async (opts: SessionDriverLaunchOptions): Promise<SessionDriver> => {
    const sessionId = opts.env.WORQLOAD_SESSION_ID ?? `anon-${Date.now()}`;
    const sessionName = tmuxSessionName(sessionId);
    const cwd = opts.cwd ?? process.cwd();
    const transcriptDir = deps.resolveTranscriptDir(cwd);
    // Claude writes the transcript at <projects>/<encoded-cwd>/<session-id>.jsonl.
    // By passing --session-id (fresh) or --resume <id> (resume) we control
    // the filename, so the tail can attach to a known path instead of
    // polling for "the new jsonl that appears" — which was unreliable when
    // multiple sessions raced in the same cwd.
    const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);

    // Detect resume mode by inspecting spawnCommand. web-server's host
    // launcher appends `--continue` when serve is resuming a session. We
    // strip it here because claude's interactive mode only honors --resume
    // <uuid> for explicit resumption; --continue is just "the most recent in
    // this cwd", which is wrong if multiple worqload sessions ever share a
    // cwd.
    const isResume = opts.spawnCommand.includes("--continue");
    const cleanedSpawn = opts.spawnCommand.filter((a) => a !== "--continue");

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

    let spawned = false;

    // Start the tail in the background. It waits for `transcriptPath` to
    // appear (which only happens once claude is actually running and has
    // processed the first message), then streams JSONL entries through
    // classifyClaudeLine.
    const tailTask = (async () => {
      const deadline = Date.now() + deps.transcriptWaitTimeoutMs;
      let attachedContent = "";
      while (!exitedFlag && Date.now() < deadline) {
        try {
          attachedContent = await readFile(transcriptPath, { encoding: "utf8" });
          break;
        } catch {
          await sleep(deps.pollIntervalMs);
        }
      }
      if (exitedFlag) return;
      if (Date.now() >= deadline) {
        opts.log("transcript_discovery_failed", {
          transcriptPath,
          timeoutMs: deps.transcriptWaitTimeoutMs,
        });
        resolveExit(1);
        return;
      }
      // On resume, claude reopens the transcript a prior host generation already
      // turned into events and appends to it. Start the tail past everything on
      // disk at attach so only post-resume lines are emitted; tailing from 0
      // would re-emit the whole conversation as duplicate events on every
      // resume. A fresh start tails from 0 because claude writes the file from
      // empty once it processes the first message.
      const initialOffset = isResume ? attachedContent.length : 0;
      opts.log("transcript_attached", { transcriptPath });
      await tailJsonl(
        transcriptPath,
        deps,
        () => exitedFlag,
        async (parsed) => {
          await opts.onEvent({ kind: classifyClaudeLine(parsed), payload: parsed });
        },
        initialOffset,
      );
    })();

    // Background loop: notice when the tmux session disappears (claude exited
    // on its own). Idle until the tmux session is actually spawned by the
    // first sendUserMessage("bootstrap") call.
    void (async () => {
      while (!exitedFlag) {
        await sleep(deps.pollIntervalMs);
        if (exitedFlag) break;
        if (!spawned) continue;
        const res = await deps.tmuxRun(["has-session", "-t", sessionName]);
        if (res.exitCode !== 0) {
          opts.log("tmux_session_gone", { sessionName });
          resolveExit(0);
          break;
        }
      }
    })();

    // Spawns the tmux session with claude inside, using the bootstrap text
    // as claude's positional [prompt] argument. The prompt goes through a
    // temp file + $(cat <file>) so multi-line content and shell metachars
    // pass through cleanly regardless of size.
    let bootstrapFile: string | null = null;
    const spawnTmux = async (bootstrap: string): Promise<void> => {
      await mkdir(transcriptDir, { recursive: true });
      bootstrapFile = join(deps.bootstrapFileDir, `worqload-bootstrap-${sessionId}.txt`);
      await writeFile(bootstrapFile, bootstrap);

      // Forward each env var into the tmux session.
      const envArgs: string[] = [];
      for (const [k, v] of Object.entries(opts.env)) {
        envArgs.push("-e", `${k}=${v}`);
      }

      // For fresh sessions: --session-id <uuid> pins the transcript filename.
      // For resume: --resume <uuid> tells claude to reopen that exact session
      // from the existing transcript.
      const idFlag = isResume ? "--resume" : "--session-id";
      // Re-declare the user's `ask` rules as deny for this driven session.
      // --dangerously-skip-permissions does not suppress explicit ask rules in
      // the interactive TUI, and no human is present to answer the prompt, so a
      // guarded command would hang the session forever. claude merges
      // --settings into the existing config (it does not replace it), so the
      // user's allow rules and env stay intact; only ask becomes deny.
      const askRules = await harvestAskRules(deps.resolveSettingsFiles(cwd));
      const permissionArgs = askRules.length > 0
        ? ["--settings", JSON.stringify({ permissions: { deny: askRules } })]
        : [];
      const claudeArgvWithId = [...cleanedSpawn, ...permissionArgs, idFlag, sessionId];
      const shellCmd = claudeTmuxBootstrapShellCommand(claudeArgvWithId, bootstrapFile);

      const spawnRes = await deps.tmuxRun([
        "new-session", "-d",
        "-s", sessionName,
        "-c", cwd,
        ...envArgs,
        "bash", "-c", shellCmd,
      ]);
      if (spawnRes.exitCode !== 0) {
        throw new Error(
          `tmux new-session failed (exit ${spawnRes.exitCode}). To reproduce: ` +
          `tmux new-session -d -s ${sessionName} -c ${cwd} -- bash -c ${shellSingleQuote(shellCmd)}`,
        );
      }
      spawned = true;
      opts.log("tmux_spawned", {
        sessionName,
        cwd,
        claudeArgv: claudeArgvWithId,
        bootstrapBytes: bootstrap.length,
        resume: isResume,
      });
    };

    const sendViaPaste = async (text: string): Promise<void> => {
      const bufName = nextPasteBufferName(sessionName);
      await deps.tmuxRun(["load-buffer", "-b", bufName, "-"], { stdin: text });
      // -p wraps the paste in bracketed-paste escape codes; claude's TUI
      // collapses it into a paste placeholder and Enter submits the whole
      // thing as one message. Required for any message after the first one
      // (the first arrives via the CLI prompt arg, not via paste).
      await deps.tmuxRun(["paste-buffer", "-d", "-p", "-b", bufName, "-t", sessionName]);
      await deps.tmuxRun(["send-keys", "-t", sessionName, "Enter"]);
    };

    return {
      async sendUserMessage(text, source) {
        const start = Date.now();
        try {
          if (!spawned) {
            // First message: spawn tmux with claude already configured to
            // process this text as its first prompt. Both bootstrap and the
            // resume kickoff arrive here.
            await spawnTmux(text);
          } else {
            await sendViaPaste(text);
          }
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
            error: err instanceof Error ? err.message : String(err),
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
        // Clean up the bootstrap file we wrote (best-effort).
        if (bootstrapFile) {
          try {
            await unlink(bootstrapFile);
          } catch {
            // already gone, or never created
          }
        }
        return code;
      })(),
    };
  };
}

export const tmuxClaudeDriver: SessionDriverFactory = makeTmuxClaudeDriverFactory(defaultTmuxDeps);

export interface TmuxOneShotOptions {
  // The single prompt to ask claude. Delivered as claude's positional
  // [prompt] argument, exactly like the session driver's first message.
  prompt: string;
  // The claude executable to run.
  claudeBin: string;
  // Working directory for the tmux session; also fixes which
  // <projects>/<encoded-cwd> transcript directory is read.
  cwd: string;
  // Pins both the transcript filename (--session-id) and the tmux session
  // name. Caller supplies a fresh UUID so it cannot collide with a real
  // worqload session sharing the cwd.
  sessionId: string;
  // Extra env vars forwarded into the tmux session.
  env: Record<string, string>;
}

// Run a single prompt through interactive claude inside tmux and return its
// first assistant text, so the work draws from interactive usage limits
// instead of the `claude -p` Agent SDK credit pool. This is the session
// driver's first turn in isolation: spawn claude with the prompt as its
// positional argument, tail the transcript for the first assistant text,
// then tear the tmux session down (interactive claude stays resident after
// answering, so process exit is not the completion signal). Returns null on
// spawn failure or if no assistant text appears before the timeout; the
// caller is expected to have a non-tmux fallback.
export async function tmuxOneShotText(
  opts: TmuxOneShotOptions,
  deps: TmuxDriverDeps,
): Promise<string | null> {
  const sessionName = tmuxSessionName(opts.sessionId);
  const transcriptDir = deps.resolveTranscriptDir(opts.cwd);
  const transcriptPath = join(transcriptDir, `${opts.sessionId}.jsonl`);
  const bootstrapFile = join(deps.bootstrapFileDir, `worqload-oneshot-${opts.sessionId}.txt`);

  await mkdir(transcriptDir, { recursive: true });
  await writeFile(bootstrapFile, opts.prompt);

  const cleanup = async (): Promise<void> => {
    await deps.tmuxRun(["kill-session", "-t", sessionName]).catch(() => {});
    await unlink(bootstrapFile).catch(() => {});
  };

  try {
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(opts.env)) {
      envArgs.push("-e", `${k}=${v}`);
    }
    const claudeArgv = [opts.claudeBin, "--dangerously-skip-permissions", "--session-id", opts.sessionId];
    const shellCmd = claudeTmuxBootstrapShellCommand(claudeArgv, bootstrapFile);

    const spawnRes = await deps.tmuxRun([
      "new-session", "-d",
      "-s", sessionName,
      "-c", opts.cwd,
      ...envArgs,
      "bash", "-c", shellCmd,
    ]);
    if (spawnRes.exitCode !== 0) return null;

    // Poll the predicted transcript path for the first assistant text. claude
    // only writes the file once it has processed the prompt, so absence early
    // on is expected; we keep reading the whole file each tick (one short
    // turn, so size is a non-issue) until an assistant text line shows up or
    // the deadline passes.
    const deadline = Date.now() + deps.transcriptWaitTimeoutMs;
    while (Date.now() < deadline) {
      let data: string;
      try {
        data = await readFile(transcriptPath, { encoding: "utf8" });
      } catch {
        await sleep(deps.pollIntervalMs);
        continue;
      }
      for (const line of data.split("\n")) {
        if (line.trim() === "") continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const text = assistantLineText(parsed);
        if (text !== null) return text;
      }
      await sleep(deps.pollIntervalMs);
    }
    return null;
  } finally {
    await cleanup();
  }
}
