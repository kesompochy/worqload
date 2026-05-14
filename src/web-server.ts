import type { Server, ServerWebSocket, Subprocess } from "bun";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import {
  agentEndpointPath,
  createSession,
  hostLogPath,
  saveSessionMeta,
  loadSessionMeta,
  listSessionMetas,
  reorderSessions,
  isTerminal,
  validateTransition,
  type SessionMeta,
  type SessionStatus,
} from "./session";
import { connectToHost, type HostClient, spawnDetachedHost } from "./session-host-client";
import { appendEvent, readEvents, type Event } from "./event-log";
import { realWorktreeOps, searchFileContents, type WorktreeOps } from "./worktree";
import { collectCallGraph, findDefinition, findReferences, shutdownAllLanguageServers } from "./language-servers";
import { buildStructureView, parseChangedFilePaths, structureLanguageOf } from "./structure-view";
import { parseGitRemoteUrl, buildBlobPermalink } from "./permalink";
import { writeNumberedFile, listAllFiles, moveFile, moveNumberedFile, readReadState, setReadState, markAllRead } from "./file-store";
import type { WriteNumberedFileOptions } from "./file-store";
import { formatAnchorRefLine } from "./anchor-ref";
import { backfillFeedbackAnchors } from "./feedback-anchor-backfill";
import { isSessionPreviewAlive, listActions, listAvailableActions, findAction, stopSessionPreview } from "./actions";
import { buildWebFrontend, webFrontendBuilt } from "./web-build";
import { defaultBranchNameGenerator, sanitizeBranchName, type BranchNameGenerator } from "./branch-name";
import { isAgentWorkEvent } from "../web/events-view.js";

// worqload protocol commands are part of the system contract; they must run
// without permission prompts regardless of which permission mode the rest of
// the session uses.
const WORQLOAD_PROTOCOL_ALLOW =
  "Bash(worqload report submit:*) Bash(worqload escalate submit:*) Bash(worqload escalate command:*) " +
  "Bash(worqload feedback fetch) Bash(worqload feedback fetch:*)";

// Tries to bind on the requested port and shifts upward on EADDRINUSE so a
// busy port (often the previous --watch instance lingering, or another dev
// tool) doesn't fail the boot. port=0 leaves selection to the OS, so no
// fallback is needed.
const PORT_FALLBACK_ATTEMPTS = 50;
function listenWithFallback(requestedPort: number, listen: (port: number) => Server): Server {
  if (requestedPort === 0) return listen(0);
  let port = requestedPort;
  for (let attempt = 0; attempt < PORT_FALLBACK_ATTEMPTS; attempt++) {
    try {
      return listen(port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") throw err;
      port++;
    }
  }
  throw new Error(`no free port found in range ${requestedPort}-${requestedPort + PORT_FALLBACK_ATTEMPTS - 1}`);
}

function buildDefaultSpawnCommand(driverName: "pipe" | "tmux"): string[] {
  // bypassPermissions is the default for v1 ergonomics: a -p session has no
  // human to approve prompts, so any unallowed Bash would auto-fail. Set
  // WORQLOAD_PERMISSION_MODE=default (or acceptEdits) to lock the session
  // down to only the protocol allowlist above (the agent will then be able
  // to write reports etc. but not run arbitrary dev commands).
  const permissionMode = process.env.WORQLOAD_PERMISSION_MODE || "bypassPermissions";
  if (driverName === "tmux") {
    // The tmux driver runs interactive `claude` inside a detached tmux session
    // (see src/session-driver-tmux.ts). Interactive mode does not understand
    // --input-format or --output-format; `--dangerously-skip-permissions` is
    // the interactive equivalent of bypassPermissions.
    return ["claude", "--dangerously-skip-permissions"];
  }
  return [
    "claude",
    "-p",
    "--verbose",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--permission-mode", permissionMode,
    "--allowedTools", WORQLOAD_PROTOCOL_ALLOW,
  ];
}

// Default command used by spawnDetachedHost to launch the per-session host.
// In production, the `worqload` binary is on PATH (via bun link or a build).
// Tests override this to invoke `bun src/cli.ts session-host` against the
// in-repo source.
function buildDefaultHostCommand(): string[] {
  return ["worqload", "session-host"];
}

// Per-host unix sockets live under tmpdir to dodge the ~104-char path limit
// on macOS that .worqload/sessions/<uuid>/host.sock would routinely blow past
// on tmp-rooted test setups. The random suffix makes the name unique per
// spawn so a resume never reuses the path the previous (now-exiting) host is
// about to unlink — `runHost` records the chosen path in meta.hostSocketPath
// for reconnect, so it does not need to be derivable from the session id.
function hostSocketPathFor(sessionId: string): string {
  return join(tmpdir(), "worqload", `${sessionId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}.sock`);
}

interface WsClientData {
  sessionId: string;
}

interface SessionAttachment {
  client: HostClient;
  // PID of the host process (whether we spawned it or reconnected). Used at
  // shutdown when killHosts is requested.
  hostPid?: number;
  // Defined only when this serve instance is the one that spawned the host
  // (and that host runs as a real subprocess).
  hostProc?: Subprocess;
  // The wake watchdog runs at most one timer per attachment. A new wake on
  // the same attachment clears the previous timer (giving claude its full
  // window again); attachment replacement leaves the old timer to fire and
  // bail out via the identity check in runWakeWatchdog.
  watchdogTimer?: ReturnType<typeof setTimeout>;
}

// Brings a session's host to life and returns a client for talking to it. The
// production launcher spawns `worqload session-host` as a detached subprocess;
// tests inject an in-process stand-in so the suite doesn't pay one (or two)
// process spawns per session.
export interface HostLaunchRequest {
  meta: SessionMeta;
  sessionsDir: string;
  agentEndpoint: string;
  resume: boolean;
  onEvent: (event: Event) => void;
  onDisconnect: () => void;
}
export type HostLauncher = (req: HostLaunchRequest) => Promise<{ client: HostClient; hostProc?: Subprocess }>;

export interface ServerContext {
  port: number;
  repoDir: string;
  worqloadDir: string;          // <repo>/.worqload
  sessionsDir: string;          // <repo>/.worqload/sessions
  worktreesDir: string;         // <repo>/.worktrees
  spawnCommand: string[];
  branchNameGenerator: BranchNameGenerator;
  hostLauncher: HostLauncher;
  worktreeOps: WorktreeOps;
  clients: Map<string, SessionAttachment>;
  baseUrlForAgent: string;
  wsClients: Set<ServerWebSocket<WsClientData>>;
  // Wall-clock of the latest claude_* event observed per session. The wake
  // watchdog compares it with the wake-send time to decide whether to
  // auto-resume a host whose claude has gone deaf to stdin.
  lastClaudeActivityAt: Map<string, number>;
  // Watchdog threshold. Zero (or negative) disables the watchdog entirely.
  wakeWatchdogMs: number;
}

export interface StartServerOptions {
  port?: number;                // 0 = random
  repoDir?: string;
  spawnCommand?: string[];      // override the claude binary command
  // Which SessionDriver implementation to spawn each session with. "pipe"
  // (default) runs `claude -p` and exchanges stream-json over stdio. "tmux"
  // runs interactive `claude` inside a tmux session, reading claude's JSONL
  // transcript for output — avoids the Agent SDK credit pool that `claude -p`
  // will draw from starting 2026-06-15.
  driverName?: "pipe" | "tmux";
  // Overrides the helper that turns a prompt into a short branch name.
  // Return null to skip generation; the caller then falls back to <shortId>.
  branchNameGenerator?: BranchNameGenerator;
  hostCommand?: string[];       // override how the (subprocess) host is launched
  hostLauncher?: HostLauncher;  // override host launch entirely (tests use this)
  worktreeOps?: WorktreeOps;    // override the git/worktree layer (tests use a fake)
  // Auto-resume threshold for the wake watchdog (ms). The watchdog scans for
  // a fresh claude_* event after each wake; if none arrives within this
  // window, it tears down the host and re-spawns with --continue. Zero or
  // negative disables it. Production default is 90s; tests override down.
  wakeWatchdogMs?: number;
}

export interface ShutdownOptions {
  // When true, kill the host subprocesses we own. False (default) leaves them
  // running so `worqload serve --watch` style restarts preserve sessions.
  killHosts?: boolean;
}

export interface StartedServer {
  server: Server;
  ctx: ServerContext;
  shutdown(opts?: ShutdownOptions): Promise<void>;
}

function reportsDirFor(ctx: ServerContext, sessionId: string): string {
  return join(ctx.sessionsDir, sessionId, "reports");
}

function askingDirFor(ctx: ServerContext, sessionId: string): string {
  return join(ctx.sessionsDir, sessionId, "asking");
}

// A command-approval escalation is an ordinary `asking/<NNN>-<slug>.md` (for the
// human-readable "REQUIRE APPROVAL" view) paired with this sidecar JSON holding
// the exact command to run. The `.command.json` extension keeps it out of
// `listAllFiles`, which only globs `.md`, so the rest of the escalation
// machinery treats the pair as a single asking entry.
function commandSidecarFilename(askingMdFilename: string): string {
  return askingMdFilename.replace(/\.md$/, ".command.json");
}

interface CommandApproval {
  command: string;
  reason?: string;
}

function buildCommandApprovalMarkdown(command: string, reason: string): string {
  const parts = [
    "# REQUIRE APPROVAL",
    "The agent is asking permission to run a command outside its allowlist.",
  ];
  if (reason !== "") parts.push(reason);
  parts.push("```\n" + command + "\n```");
  return parts.join("\n\n") + "\n";
}

const APPROVED_COMMAND_TIMEOUT_MS = 5 * 60_000;
const APPROVED_COMMAND_OUTPUT_LIMIT = 50_000;

function truncateOutput(text: string): string {
  if (text.length <= APPROVED_COMMAND_OUTPUT_LIMIT) return text;
  const dropped = text.length - APPROVED_COMMAND_OUTPUT_LIMIT;
  return `${text.slice(0, APPROVED_COMMAND_OUTPUT_LIMIT)}\n[... ${dropped} more characters truncated]`;
}

interface ApprovedCommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Runs an approved command via `sh -c` in the session worktree (mirroring how
// claude's Bash tool would have run it). Killed after a timeout so a hung
// command can't wedge the resolve request.
async function runApprovedCommand(command: string, cwd: string): Promise<ApprovedCommandResult> {
  const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill("SIGKILL"); } catch {} }, APPROVED_COMMAND_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return {
    exitCode: typeof exitCode === "number" ? exitCode : null,
    signal: proc.signalCode ?? null,
    stdout: truncateOutput(stdout),
    stderr: truncateOutput(stderr),
    timedOut,
  };
}

function describeCommandExit(result: ApprovedCommandResult): string {
  if (result.timedOut) return `killed (timed out after ${APPROVED_COMMAND_TIMEOUT_MS / 60_000}m)`;
  if (result.signal) return `killed by ${result.signal}`;
  return String(result.exitCode ?? "unknown");
}

function fencedBlock(text: string): string {
  return "```\n" + (text === "" ? "(empty)" : text.replace(/\n$/, "")) + "\n```";
}

function formatApprovedCommandFeedback(escalationFilename: string, command: string, result: ApprovedCommandResult, note: string): string {
  const parts = [
    `Re: command approval ${escalationFilename}`,
    "The human approved this command. worqload ran it in your worktree; here is the result.",
    `## Command\n\n${fencedBlock(command)}`,
  ];
  if (note !== "") parts.push(`## Human note\n\n${note}`);
  parts.push(
    `## Exit code\n\n${describeCommandExit(result)}`,
    `## stdout\n\n${fencedBlock(result.stdout)}`,
    `## stderr\n\n${fencedBlock(result.stderr)}`,
  );
  return parts.join("\n\n") + "\n";
}

function formatRejectedCommandFeedback(escalationFilename: string, command: string, reason: string): string {
  const parts = [
    `Re: command approval ${escalationFilename}`,
    "The human rejected this command; it was not run. Do not retry it. Use a different approach, or escalate for guidance.",
    `## Rejected command\n\n${fencedBlock(command)}`,
  ];
  if (reason !== "") parts.push(`## Reason given\n\n${reason}`);
  return parts.join("\n\n") + "\n";
}

function feedbackInboxDirFor(ctx: ServerContext, sessionId: string): string {
  return join(ctx.sessionsDir, sessionId, "feedback", "inbox");
}

function feedbackReadDirFor(ctx: ServerContext, sessionId: string): string {
  return join(ctx.sessionsDir, sessionId, "feedback", "read");
}

// serve rewrites this file (its current base URL) on every (re)connect; the
// agent CLI reads it so it follows serve across a restart on a different port.
async function writeAgentEndpointFile(ctx: ServerContext, sessionId: string): Promise<void> {
  await mkdir(join(ctx.sessionsDir, sessionId), { recursive: true });
  await Bun.write(agentEndpointPath(ctx.sessionsDir, sessionId), ctx.baseUrlForAgent);
}

function broadcastEvent(ctx: ServerContext, sessionId: string, event: import("./event-log").Event): void {
  if (event.kind.startsWith("claude_")) {
    ctx.lastClaudeActivityAt.set(sessionId, Date.now());
  }
  const payload = JSON.stringify({ sessionId, event });
  for (const ws of ctx.wsClients) {
    if (ws.data.sessionId === sessionId) {
      try { ws.send(payload); } catch { /* dead socket */ }
    }
  }
}

async function appendAndBroadcast(
  ctx: ServerContext,
  sessionId: string,
  partial: Parameters<typeof appendEvent>[1],
): Promise<import("./event-log").Event> {
  const event = await appendEvent(sessionId, partial, ctx.sessionsDir);
  broadcastEvent(ctx, sessionId, event);
  return event;
}

async function transitionStatus(
  ctx: ServerContext,
  meta: SessionMeta,
  to: SessionStatus,
): Promise<SessionMeta> {
  validateTransition(meta.status, to);
  const updated: SessionMeta = {
    ...meta,
    status: to,
    ...(isTerminal(to) ? { endedAt: new Date().toISOString() } : {}),
  };
  await saveSessionMeta(updated, ctx.sessionsDir);
  return updated;
}

// Production host launcher: spawn `worqload session-host` (test override:
// `bun src/cli.ts session-host`) as a detached child, connect over its unix
// socket, and wait for it to finish replaying the event log (empty for a fresh
// session). The host — not serve — writes the session_started / session_resumed
// event and sends claude its first message. On resume claude's prior
// conversation is continued (`--continue`), so we still connect from seq 0.
function makeSpawnHostLauncher(config: { hostCommand: string[]; spawnCommand: string[]; driverName: "pipe" | "tmux" }): HostLauncher {
  return async ({ meta, sessionsDir, agentEndpoint, resume, onEvent, onDisconnect }) => {
    const socketPath = hostSocketPathFor(meta.id);
    const logFile = hostLogPath(sessionsDir, meta.id);
    const hostProc = spawnDetachedHost({
      sessionId: meta.id,
      sessionsDir,
      socketPath,
      agentEndpoint,
      spawnCommand: resume ? [...config.spawnCommand, "--continue"] : config.spawnCommand,
      hostCommand: config.hostCommand,
      logFile,
      // Only pass `--driver` when it differs from the host CLI's default
      // ("pipe"). Avoids churning host argv in the common case.
      ...(config.driverName === "tmux" ? { driverName: "tmux" as const } : {}),
      ...(resume && { resume: true }),
    });
    const client = await connectToHost({ socketPath, sinceSeq: 0, onEvent, onDisconnect });
    await client.replayCompleted.catch(() => {});
    return { client, hostProc };
  };
}

// Both runHost (host process) and serve append diagnostic entries to the same
// per-session host.log to make the wake path debuggable post-hoc. Failures
// here must not bubble up — diagnostic logging is best-effort.
function appendHostLog(
  ctx: ServerContext,
  sessionId: string,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const path = hostLogPath(ctx.sessionsDir, sessionId);
  const line = JSON.stringify({ ts: new Date().toISOString(), source: "serve", event, ...fields }) + "\n";
  try {
    appendFileSync(path, line);
  } catch {
    // session dir may have been cleaned up; ignore
  }
}

// Production default for the wake watchdog. The audit's failure cases sat
// silent for 21s to 27 minutes after the wake; 90s is well past any normal
// "claude is mid-turn on the previous message" delay while still cutting the
// worst-case waiting time short.
const DEFAULT_WAKE_WATCHDOG_MS = 90_000;

// One pending watchdog per attachment. A new wake on the same attachment
// resets the deadline; an attachment replacement leaves the prior timer
// pending, but runWakeWatchdog's identity check makes it a no-op.
function scheduleWakeWatchdog(ctx: ServerContext, sessionId: string, att: SessionAttachment): void {
  if (ctx.wakeWatchdogMs <= 0) return;
  if (att.watchdogTimer) clearTimeout(att.watchdogTimer);
  const wakeAt = Date.now();
  const timer = setTimeout(() => { void runWakeWatchdog(ctx, sessionId, wakeAt, att); }, ctx.wakeWatchdogMs);
  // The watchdog is purely advisory; it must never keep the event loop alive
  // past the rest of the server.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  att.watchdogTimer = timer;
}

async function runWakeWatchdog(
  ctx: ServerContext,
  sessionId: string,
  wakeAt: number,
  expectedAtt: SessionAttachment,
): Promise<void> {
  const lastActivity = ctx.lastClaudeActivityAt.get(sessionId) ?? 0;
  if (lastActivity >= wakeAt) return; // claude responded in time
  const meta = await loadSessionMeta(sessionId, ctx.sessionsDir);
  if (!meta || isTerminal(meta.status)) return; // session has moved on
  // Identity check: the attachment that received the wake must still be the
  // current one. If the user manually resumed (or a previous watchdog already
  // respawned), ctx.clients now holds a different attachment and this fire is
  // stale.
  const currentAtt = ctx.clients.get(sessionId);
  if (currentAtt !== expectedAtt) return;
  const silenceMs = Date.now() - wakeAt;
  appendHostLog(ctx, sessionId, "watchdog_auto_resume", { silenceMs, hostPid: expectedAtt.hostPid });
  await appendAndBroadcast(ctx, sessionId, {
    kind: "session_auto_resumed",
    payload: { reason: "wake_unanswered", silenceMs },
  });
  try {
    await expectedAtt.client.kill("SIGTERM");
    await Promise.race([
      expectedAtt.client.exited,
      new Promise((r) => setTimeout(r, 500)),
    ]);
    if (ctx.clients.get(sessionId) === expectedAtt) {
      await expectedAtt.client.kill("SIGKILL");
      await expectedAtt.client.exited.catch(() => {});
    }
  } catch {
    // host already gone; fall through to respawn
  }
  if (ctx.clients.get(sessionId) === expectedAtt) {
    ctx.clients.delete(sessionId);
  }
  const { endedAt: _endedAt, archivedAt: _archivedAt, ...rest } = meta;
  const resumed: SessionMeta = { ...rest, status: "running" };
  await saveSessionMeta(resumed, ctx.sessionsDir);
  try {
    await spawnAndAttachHost(ctx, resumed, { resume: true });
  } catch (err) {
    appendHostLog(ctx, sessionId, "watchdog_respawn_failed", { error: String(err) });
  }
}

async function spawnAndAttachHost(
  ctx: ServerContext,
  meta: SessionMeta,
  opts: { resume?: boolean } = {},
): Promise<HostClient> {
  await writeAgentEndpointFile(ctx, meta.id);
  const { client, hostProc } = await ctx.hostLauncher({
    meta,
    sessionsDir: ctx.sessionsDir,
    agentEndpoint: ctx.baseUrlForAgent,
    resume: opts.resume ?? false,
    onEvent: (event) => broadcastEvent(ctx, meta.id, event),
    onDisconnect: () => {
      ctx.clients.delete(meta.id);
    },
  });
  ctx.clients.set(meta.id, { client, hostProc, hostPid: hostProc?.pid });
  return client;
}

// Reconnect to an already-running host after the serve process restarted.
// Returns null if the socket isn't reachable (host has died).
async function reconnectToHost(ctx: ServerContext, meta: SessionMeta): Promise<HostClient | null> {
  if (!meta.hostSocketPath) return null;
  try {
    await writeAgentEndpointFile(ctx, meta.id);
    const lastSeq = (await readEvents(meta.id, 1, ctx.sessionsDir)).at(-1)?.seq ?? 0;
    const client = await connectToHost({
      socketPath: meta.hostSocketPath,
      sinceSeq: lastSeq,
      connectTimeoutMs: 500,
      onEvent: (event) => broadcastEvent(ctx, meta.id, event),
      onDisconnect: () => {
        ctx.clients.delete(meta.id);
      },
    });
    await client.replayCompleted.catch(() => {});
    ctx.clients.set(meta.id, { client, hostPid: meta.hostPid });
    return client;
  } catch {
    return null;
  }
}

export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const repoDir = resolve(opts.repoDir ?? process.cwd());
  const worqloadDir = join(repoDir, ".worqload");
  const sessionsDir = join(worqloadDir, "sessions");
  const worktreesDir = join(repoDir, ".worktrees");
  const driverName = opts.driverName ?? "pipe";
  const spawnCommand = opts.spawnCommand ?? buildDefaultSpawnCommand(driverName);
  const branchNameGenerator = opts.branchNameGenerator ?? defaultBranchNameGenerator;
  const hostCommand = opts.hostCommand ?? buildDefaultHostCommand();
  const hostLauncher = opts.hostLauncher ?? makeSpawnHostLauncher({ hostCommand, spawnCommand, driverName });
  const worktreeOps = opts.worktreeOps ?? realWorktreeOps;

  await mkdir(sessionsDir, { recursive: true });
  // Migrate any anchored feedback still carrying its anchor as a `Re:` line in
  // the body over to the `.meta.json` sidecar (no-op once everything's migrated).
  await backfillFeedbackAnchors(sessionsDir);
  // The frontend is a Vite build under web/dist/; produce it on first run so a
  // fresh checkout (or a forgotten `bun run web:build`) still serves a working
  // UI. Editing the frontend afterwards needs a rebuild (`bun run web:build`).
  if (!webFrontendBuilt()) await buildWebFrontend();

  // ctx is assigned right after Bun.serve returns; the fetch handler
  // captures the binding and only reads it when a request arrives, by which
  // point the assignment below has run.
  let ctx!: ServerContext;

  const server = listenWithFallback(opts.port ?? 3456, port => Bun.serve<WsClientData, undefined>({
    hostname: "127.0.0.1",
    port,
    // Bun's default idleTimeout (~10s) drops a TCP connection that has had no
    // bytes either way for the timeout. /sessions/:id/call-graph and
    // /sessions/:id/diff can sit silent on the wire well past that while the
    // server is waiting on a language server / git — the fetch then surfaces
    // as a generic "Failed to fetch" with no clue what happened. Raise it.
    idleTimeout: 180,
    fetch(req, srv) {
      const url = new URL(req.url);
      const wsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/stream$/);
      if (wsMatch) {
        const sessionId = wsMatch[1];
        if (srv.upgrade<WsClientData>(req, { data: { sessionId } })) {
          // The client sends a {type:"subscribe", lastSeq:N} message right
          // after connecting; replay happens in the message handler.
          return undefined as unknown as Response;
        }
        return new Response("upgrade failed", { status: 400 });
      }
      return handleRequest(req, ctx);
    },
    websocket: {
      open(ws) {
        ctx.wsClients.add(ws);
      },
      async message(ws, raw) {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        try {
          const msg = JSON.parse(text) as { type?: string; lastSeq?: number };
          if (msg.type === "subscribe") {
            const fromSeq = (msg.lastSeq ?? 0) + 1;
            const events = await readEvents(ws.data.sessionId, fromSeq, ctx.sessionsDir);
            for (const ev of events) {
              try { ws.send(JSON.stringify({ sessionId: ws.data.sessionId, event: ev })); } catch {}
            }
          }
        } catch { /* ignore malformed */ }
      },
      close(ws) {
        ctx.wsClients.delete(ws);
      },
    },
  }));

  ctx = {
    repoDir,
    worqloadDir,
    sessionsDir,
    worktreesDir,
    spawnCommand,
    branchNameGenerator,
    hostLauncher,
    worktreeOps,
    clients: new Map(),
    port: server.port,
    baseUrlForAgent: `http://127.0.0.1:${server.port}`,
    wsClients: new Set(),
    lastClaudeActivityAt: new Map(),
    wakeWatchdogMs: opts.wakeWatchdogMs ?? DEFAULT_WAKE_WATCHDOG_MS,
  };

  await reconcileNonTerminalSessions(ctx);

  async function shutdown(opts: ShutdownOptions = {}): Promise<void> {
    for (const att of ctx.clients.values()) {
      if (opts.killHosts) {
        // Tell the host (claude's parent) to SIGKILL claude and exit; that's
        // the only path that reliably reaps the claude child. SIGKILLing the
        // host directly would orphan claude.
        try { await att.client.kill("SIGKILL"); } catch { /* socket may be down */ }
        await Promise.race([
          att.client.exited.catch(() => {}),
          new Promise((r) => setTimeout(r, 1000)),
        ]);
      }
      try { await att.client.close(); } catch { /* already closed */ }
      if (opts.killHosts && att.hostPid !== undefined && isPidAlive(att.hostPid)) {
        // Host didn't honour the IPC kill — last resort.
        try { process.kill(att.hostPid, "SIGKILL"); } catch { /* already dead */ }
        if (att.hostProc) await att.hostProc.exited.catch(() => {});
      }
    }
    ctx.clients.clear();
    await shutdownAllLanguageServers();
    server.stop(true);
  }

  return { server, ctx, shutdown };
}

// -------- routing --------

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: (req: Request, ctx: ServerContext, params: Record<string, string>) => Response | Promise<Response>;
}

function defineRoute(
  method: string,
  pathPattern: string,
  handler: Route["handler"],
): Route {
  const paramNames: string[] = [];
  const regexStr = pathPattern.replace(/:(\w+)/g, (_, n) => {
    paramNames.push(n);
    return "([^/]+)";
  });
  return { method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler };
}

const ROUTES: Route[] = [
  defineRoute("GET",  "/", getIndex),
  defineRoute("GET",  "/favicon", getFavicon),
  defineRoute("GET",  "/favicon.ico", getFavicon),
  defineRoute("GET",  "/assets/:filename", getAsset),
  defineRoute("GET",  "/meta", getMeta),
  defineRoute("POST", "/sessions", postSessions),
  defineRoute("POST", "/sessions/order", postSessionsOrder),
  defineRoute("GET",  "/sessions", getSessions),
  defineRoute("GET",  "/sessions/:id", getSessionDetail),
  defineRoute("POST", "/sessions/:id/stop", postStop),
  defineRoute("POST", "/sessions/:id/wake", postWake),
  defineRoute("POST", "/sessions/:id/resume", postResume),
  defineRoute("POST", "/sessions/:id/archive", postArchive),
  defineRoute("POST", "/sessions/:id/unarchive", postUnarchive),
  defineRoute("DELETE", "/sessions/:id", deleteSession),
  defineRoute("POST", "/sessions/:id/title", postTitle),
  defineRoute("POST", "/sessions/:id/feedback", postFeedback),
  defineRoute("GET",  "/sessions/:id/feedback", getFeedbackHistory),
  defineRoute("POST", "/sessions/:id/escalations/:filename/resolve", postEscalationResolve),
  defineRoute("GET",  "/sessions/:id/reports", getReports),
  defineRoute("POST", "/sessions/:id/reports/read-all", postReportsReadAll),
  defineRoute("POST", "/sessions/:id/reports/:filename/read", postReportRead),
  defineRoute("POST", "/sessions/:id/reports/:filename/unread", postReportUnread),
  defineRoute("GET",  "/sessions/:id/asking", getAsking),
  defineRoute("GET",  "/sessions/:id/diff", getDiff),
  defineRoute("GET",  "/sessions/:id/files", getFiles),
  defineRoute("GET",  "/sessions/:id/structure", getStructure),
  defineRoute("GET",  "/sessions/:id/call-graph", getCallGraph),
  defineRoute("GET",  "/sessions/:id/file", getFile),
  defineRoute("GET",  "/sessions/:id/search", getFileSearch),
  defineRoute("GET",  "/sessions/:id/code-nav/definition", getCodeNavDefinition),
  defineRoute("GET",  "/sessions/:id/code-nav/references", getCodeNavReferences),
  defineRoute("GET",  "/sessions/:id/permalink", getPermalink),
  defineRoute("GET",  "/actions", getActions),
  defineRoute("GET",  "/sessions/:id/actions", getSessionActions),
  defineRoute("POST", "/sessions/:id/actions/:actionId", postSessionAction),
  defineRoute("POST", "/internal/sessions/:id/reports", postInternalReports),
  defineRoute("POST", "/internal/sessions/:id/escalations", postInternalEscalations),
  defineRoute("POST", "/internal/sessions/:id/command-approvals", postInternalCommandApprovals),
  defineRoute("GET",  "/internal/sessions/:id/feedback", getInternalFeedback),
];

const WEB_DIST_DIR = join(import.meta.dir, "..", "web", "dist");
const INDEX_HTML_PATH = join(WEB_DIST_DIR, "index.html");
const ASSETS_DIR = join(WEB_DIST_DIR, "assets");

async function getIndex(): Promise<Response> {
  return new Response(Bun.file(INDEX_HTML_PATH), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

// Served at /favicon when no per-repo override exists. Three stacked bars on a
// dark tile — a nod to the load-average framing (parallel sessions, varying
// length of work). Inlined rather than shipped as a file so it survives the
// `bun build --compile` binary without a sidecar asset.
const DEFAULT_FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#1f2430"/>' +
  '<rect x="14" y="18" width="36" height="6" rx="3" fill="#7dd3fc"/>' +
  '<rect x="14" y="29" width="24" height="6" rx="3" fill="#a5b4fc"/>' +
  '<rect x="14" y="40" width="30" height="6" rx="3" fill="#86efac"/>' +
  "</svg>\n";

// A repo can override the browser tab icon by dropping a `favicon.<ext>` into
// its `.worqload/` directory; otherwise the built-in SVG above is served.
const CUSTOM_FAVICON_EXTENSIONS = [".svg", ".png", ".ico", ".jpg", ".jpeg", ".gif", ".webp"];

async function getFavicon(_req: Request, ctx: ServerContext): Promise<Response> {
  for (const ext of CUSTOM_FAVICON_EXTENSIONS) {
    const file = Bun.file(join(ctx.worqloadDir, `favicon${ext}`));
    if (await file.exists()) {
      return new Response(file, {
        headers: { "content-type": ASSET_CONTENT_TYPES[ext] ?? "application/octet-stream" },
      });
    }
  }
  return new Response(DEFAULT_FAVICON_SVG, {
    headers: { "content-type": "image/svg+xml; charset=utf-8" },
  });
}

async function getMeta(_req: Request, ctx: ServerContext): Promise<Response> {
  return json({ repoDir: ctx.repoDir, repoName: basename(ctx.repoDir) });
}

// Vite emits content-hashed bundles under web/dist/assets/. Serving any basename
// from that directory is safe — the route pattern already excludes slashes, and
// the charset check below rejects anything that could be a traversal segment —
// and a name with no matching file just 404s.
async function getAsset(_req: Request, _ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  const { filename } = params;
  if (!/^[A-Za-z0-9._-]+$/.test(filename) || filename.includes("..")) {
    return new Response("not found", { status: 404 });
  }
  const file = Bun.file(join(ASSETS_DIR, filename));
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file, {
    headers: { "content-type": ASSET_CONTENT_TYPES[extname(filename)] ?? "application/octet-stream" },
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}

// On server start, walk all non-terminal sessions and try to rejoin the host
// (which survives serve restarts). If the host's PID is dead the session is
// orphaned and gets marked crashed; otherwise we attach a fresh client and
// resume streaming live events.
async function reconcileNonTerminalSessions(ctx: ServerContext): Promise<void> {
  const all = await listSessionMetas(ctx.sessionsDir);
  for (const meta of all) {
    if (isTerminal(meta.status)) continue;
    // Seed sessions in a preview repo have no real host; don't auto-flip them
    // to crashed for failing the host-alive check.
    if (meta.mock) continue;
    const hostAlive = meta.hostPid !== undefined && isPidAlive(meta.hostPid);
    if (hostAlive) {
      const client = await reconnectToHost(ctx, meta);
      if (client) continue;
    }
    await saveSessionMeta(
      { ...meta, status: "crashed", endedAt: new Date().toISOString() },
      ctx.sessionsDir,
    );
    await appendEvent(
      meta.id,
      { kind: "session_crashed", payload: { reason: "server_restart_orphan" } },
      ctx.sessionsDir,
    );
  }
}

async function handleRequest(req: Request, ctx: ServerContext): Promise<Response> {
  const url = new URL(req.url);
  for (const route of ROUTES) {
    if (route.method !== req.method) continue;
    const m = url.pathname.match(route.pattern);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
    try {
      return await route.handler(req, ctx, params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  }
  return json({ error: "not found" }, 404);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withSession(
  ctx: ServerContext,
  sessionId: string,
  fn: (meta: SessionMeta) => Response | Promise<Response>,
): Promise<Response> {
  const meta = await loadSessionMeta(sessionId, ctx.sessionsDir);
  if (!meta) return json({ error: "session not found" }, 404);
  return fn(meta);
}

// -------- handlers: public --------

interface PostSessionsBody {
  prompt: string;
  baseBranch?: string;
  title?: string;
  branchName?: string;
}

async function postSessions(req: Request, ctx: ServerContext): Promise<Response> {
  const body = (await req.json()) as PostSessionsBody;
  if (!body || typeof body.prompt !== "string" || body.prompt.trim() === "") {
    return json({ error: "prompt is required" }, 400);
  }

  const baseBranch = body.baseBranch?.trim() || (await ctx.worktreeOps.currentBranch(ctx.repoDir));
  const baseCommit = await ctx.worktreeOps.resolveBaseCommit(baseBranch, ctx.repoDir);

  // worktreePath and branchName are populated after the id is assigned below
  // (we need the id to compute the worktree dir and the shortId fallback).
  const tentative = createSession({
    prompt: body.prompt,
    baseBranch,
    baseCommit,
    worktreePath: "",
    branchName: "",
    title: body.title,
  });

  const branchName = await resolveBranchName({
    explicit: body.branchName,
    prompt: body.prompt,
    fallback: tentative.id.slice(0, 8),
    generator: ctx.branchNameGenerator,
  });
  if (branchName === null) {
    return json({ error: "branchName is not a valid git ref" }, 400);
  }

  const reportsDir = reportsDirFor(ctx, tentative.id);
  let worktreePath: string;
  try {
    ({ worktreePath } = await ctx.worktreeOps.createSessionWorktree({
      sessionId: tentative.id,
      repoDir: ctx.repoDir,
      baseBranch,
      branchName,
      reportsDirAbsolute: reportsDir,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 400);
  }

  const meta: SessionMeta = { ...tentative, worktreePath, branchName };
  await saveSessionMeta(meta, ctx.sessionsDir);
  await spawnAndAttachHost(ctx, meta);

  const stored = await loadSessionMeta(meta.id, ctx.sessionsDir);
  return json({ meta: stored ?? meta }, 201);
}

async function resolveBranchName(params: {
  explicit?: string;
  prompt: string;
  fallback: string;
  generator: BranchNameGenerator;
}): Promise<string | null> {
  if (params.explicit && params.explicit.trim() !== "") {
    return sanitizeBranchName(params.explicit);
  }
  const generated = await params.generator(params.prompt).catch(() => null);
  if (generated !== null) return generated;
  return params.fallback;
}

async function getSessions(req: Request, ctx: ServerContext): Promise<Response> {
  const url = new URL(req.url);
  const archivedParam = url.searchParams.get("archived");
  const includeArchived = url.searchParams.get("includeArchived") === "true";
  const sessions = await listSessionMetas(ctx.sessionsDir);
  // archived=only is the archives-tab feed; takes precedence over includeArchived.
  const filtered = archivedParam === "only"
    ? sessions.filter(s => s.archivedAt)
    : includeArchived
      ? sessions
      : sessions.filter(s => !s.archivedAt);
  const decorated = await Promise.all(filtered.map(async meta => {
    const dir = reportsDirFor(ctx, meta.id);
    const [reports, readSet, events] = await Promise.all([
      listAllFiles(dir),
      readReadState(dir),
      readEvents(meta.id, 1, ctx.sessionsDir),
    ]);
    const unreadReportCount = reports.reduce((n, r) => n + (readSet.has(r.filename) ? 0 : 1), 0);
    // The sidebar's liveness signal: when the agent last did something — its run
    // or a step within it, not a report/feedback/escalation. Undefined until the
    // session has produced one.
    const lastAgentEventAt = events.filter(isAgentWorkEvent).at(-1)?.timestamp;
    return { ...meta, unreadReportCount, lastAgentEventAt };
  }));
  return json({ sessions: decorated });
}

interface SessionsOrderBody {
  ids?: unknown;
}

async function postSessionsOrder(req: Request, ctx: ServerContext): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as SessionsOrderBody;
  if (!Array.isArray(body.ids) || !body.ids.every(id => typeof id === "string")) {
    return json({ error: "ids must be an array of session ids" }, 400);
  }
  await reorderSessions(body.ids as string[], ctx.sessionsDir);
  return json({ ok: true });
}

async function postArchive(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    if (!isTerminal(meta.status)) {
      return json({ error: "stop the session before archiving" }, 400);
    }
    if (meta.archivedAt) return json({ meta });
    // Archiving abandons the session — the preview that points at its
    // worktree would keep serving stale code (and tie up its port) with no
    // sidebar entry to surface a Stop button. The client gets a 409 so it
    // can warn the human; passing `?stopPreview=true` accepts the warning
    // and asks the server to SIGTERM the preview before archiving.
    const preview = isSessionPreviewAlive(meta);
    if (preview.alive) {
      const force = new URL(req.url).searchParams.get("stopPreview") === "true";
      if (!force) {
        return json(
          { error: "preview-running", message: "preview server is still running for this session", pid: preview.pid, url: preview.url },
          409,
        );
      }
      await stopSessionPreview(meta);
    }
    const updated: SessionMeta = { ...meta, archivedAt: new Date().toISOString() };
    await saveSessionMeta(updated, ctx.sessionsDir);
    return json({ meta: updated });
  });
}

// Inverse of postArchive: drops `archivedAt` so the session reappears in the
// default sidebar list. A safety net for accidental archives — the session's
// worktree and records are untouched (only DELETE removes those). No-op when
// the session is already unarchived.
async function postUnarchive(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    if (!meta.archivedAt) return json({ meta });
    const { archivedAt: _archivedAt, ...rest } = meta;
    const updated: SessionMeta = rest;
    await saveSessionMeta(updated, ctx.sessionsDir);
    return json({ meta: updated });
  });
}

// Permanent delete: only allowed after archive. Removes the worktree, the
// working branch, and the whole .worqload/sessions/<id>/ directory (reports,
// events, feedback, escalations — everything). No undo. Archive is the soft
// step; this is the hard step.
async function deleteSession(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    if (!meta.archivedAt) {
      return json({ error: "archive the session before deleting" }, 400);
    }
    ctx.clients.delete(meta.id);
    ctx.lastClaudeActivityAt.delete(meta.id);
    try {
      await ctx.worktreeOps.removeWorktree(meta.worktreePath, meta.branchName, ctx.repoDir);
    } catch {
      // worktree already gone (manual cleanup, repo moved, ...) — keep going so
      // the session dir still gets cleared.
    }
    // The structure tab's function-mode Before split may have materialised a
    // sibling worktree at the diff base; remove it too. Detached, so no branch
    // to delete. Best-effort: most sessions never create one.
    try {
      const basePath = ctx.worktreeOps.baseWorktreePathFor(meta.worktreePath);
      await ctx.worktreeOps.removeWorktree(basePath, undefined, ctx.repoDir);
    } catch {
      /* base worktree was never created or already gone */
    }
    await rm(join(ctx.sessionsDir, meta.id), { recursive: true, force: true });
    return json({ ok: true });
  });
}

interface TitleBody {
  title?: string;
}

// The display name shown in the sidebar and detail header. Without it the UI
// falls back to the head of the initial prompt, which reads as the user's
// opening message to the agent and is hard to tell apart at a glance — so this
// lets the human give the session a short alias. Empty/whitespace drops the
// field, reinstating the prompt-head fallback.
async function postTitle(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const body = (await req.json().catch(() => ({}))) as TitleBody;
    if (typeof body.title !== "string") {
      return json({ error: "title must be a string" }, 400);
    }
    const trimmed = body.title.trim();
    const { title: _previous, ...rest } = meta;
    const updated: SessionMeta = trimmed === "" ? rest : { ...rest, title: trimmed };
    await saveSessionMeta(updated, ctx.sessionsDir);
    return json({ meta: updated });
  });
}

async function getFeedbackHistory(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const inbox = await listAllFiles(feedbackInboxDirFor(ctx, meta.id));
    const read = await listAllFiles(feedbackReadDirFor(ctx, meta.id));
    const all = [
      ...inbox.map(f => ({ filename: f.filename, content: f.content, status: "unread" as const, anchor: f.meta?.anchor })),
      ...read.map(f => ({ filename: f.filename, content: f.content, status: "read" as const, anchor: f.meta?.anchor })),
    ];
    all.sort((a, b) => b.filename.localeCompare(a.filename));
    return json({ messages: all });
  });
}

async function getSessionDetail(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const events = await readEvents(meta.id, 1, ctx.sessionsDir);
    return json({ meta, events });
  });
}

async function getReports(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const dir = reportsDirFor(ctx, meta.id);
    const [reports, readSet] = await Promise.all([listAllFiles(dir), readReadState(dir)]);
    return json({
      reports: reports.map(r => ({
        filename: r.filename,
        content: r.content,
        read: readSet.has(r.filename),
        replyTo: r.meta?.replyTo,
      })),
    });
  });
}

async function setReportReadFlag(
  ctx: ServerContext,
  params: Record<string, string>,
  read: boolean,
): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const dir = reportsDirFor(ctx, meta.id);
    const filename = decodeURIComponent(params.filename);
    const target = Bun.file(join(dir, filename));
    if (!(await target.exists())) return json({ error: "report not found" }, 404);
    await setReadState(dir, filename, read);
    await appendAndBroadcast(ctx, meta.id, {
      kind: read ? "report_read" : "report_unread",
      payload: { filename },
    });
    return json({ ok: true, filename, read });
  });
}

async function postReportRead(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return setReportReadFlag(ctx, params, true);
}

// Marks every report of the session read in one shot — the "clear all the
// unread badges" gesture. Emits a single report_read event carrying the
// filenames it changed (none when nothing was unread), rather than one per
// file, so connected clients refresh once instead of once per report.
async function postReportsReadAll(
  _req: Request,
  ctx: ServerContext,
  params: Record<string, string>,
): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const newlyRead = await markAllRead(reportsDirFor(ctx, meta.id));
    if (newlyRead.length > 0) {
      await appendAndBroadcast(ctx, meta.id, { kind: "report_read", payload: { filenames: newlyRead } });
    }
    return json({ ok: true, read: newlyRead });
  });
}

async function postReportUnread(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return setReportReadFlag(ctx, params, false);
}

async function getAsking(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const dir = askingDirFor(ctx, meta.id);
    const asking = await listAllFiles(dir);
    const decorated = await Promise.all(asking.map(async a => {
      const sidecar = Bun.file(join(dir, commandSidecarFilename(a.filename)));
      if (await sidecar.exists()) {
        try {
          const parsed = (await sidecar.json()) as CommandApproval;
          if (typeof parsed?.command === "string") {
            return { filename: a.filename, content: a.content, command: parsed.command };
          }
        } catch { /* corrupt sidecar — fall back to a plain escalation entry */ }
      }
      return { filename: a.filename, content: a.content };
    }));
    return json({ asking: decorated });
  });
}

// We hand the full file content (every unchanged line) to the browser so the
// diff view can let the human expand context locally without another round
// trip. -U with a value larger than any realistic file effectively means "all".
const FULL_FILE_CONTEXT_LINES = 1_000_000;

async function getDiff(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    try {
      const diffBase = await ctx.worktreeOps.resolveDiffBase(meta.worktreePath, meta.baseBranch, meta.baseCommit);
      const diff = await ctx.worktreeOps.gitDiff(meta.worktreePath, diffBase, FULL_FILE_CONTEXT_LINES);
      return new Response(diff, { headers: { "content-type": "text/plain; charset=utf-8" } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  });
}

async function getFiles(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const paths = await ctx.worktreeOps.listWorktreeFiles(meta.worktreePath);
    return json({ paths });
  });
}

// The Structure tab's import-dependency picture: by default the changeset's
// source files plus the surrounding files that import them or that they import
// (a couple of hops out), with import cycles flagged. Built from the same diff
// base as the Diff tab; only JS/TS-family and `.svelte` files are graph nodes.
//
// `?anchorPath=<path>` switches the graph's seed away from the diff to a
// specific file (the human picked it from the Files or Diff tab); the diff is
// still consulted, but only so changed files in the anchor neighbourhood keep
// their "changed" emphasis. `?hops=<n>` (clamped to [0, 4]) overrides the
// neighbourhood radius.
//
// `?side=before` switches the source corpus from the current worktree to the
// diff base's tree: file list, file contents, and the import graph are all
// computed at the base commit, so the Structure tab's split view can show the
// graph as it was before the branch's changes. `after` (the default) keeps the
// current behaviour.
async function getStructure(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    try {
      const url = new URL(req.url);
      const anchorPath = (url.searchParams.get("anchorPath") || "").trim() || null;
      const hops = parseHopsParam(url.searchParams.get("hops"));
      const side = parseSideParam(url.searchParams.get("side"));
      const diffBase = await ctx.worktreeOps.resolveDiffBase(meta.worktreePath, meta.baseBranch, meta.baseCommit);
      const diff = await ctx.worktreeOps.gitDiff(meta.worktreePath, diffBase);
      const diffChanged = parseChangedFilePaths(diff);

      const allPaths = side === "before"
        ? await ctx.worktreeOps.listFilesAtRevision(meta.worktreePath, diffBase)
        : await ctx.worktreeOps.listWorktreeFiles(meta.worktreePath);
      const readSource: (path: string) => Promise<string | null> = side === "before"
        ? async path => {
            const result = await ctx.worktreeOps.readFileAtRevision(meta.worktreePath, diffBase, path);
            return result.kind === "text" ? result.content : null;
          }
        : async path => {
            const result = await ctx.worktreeOps.readWorktreeFile(meta.worktreePath, path);
            return result.kind === "text" ? result.content : null;
          };

      // In Before mode the diff's changed paths drive seeding, but a path that
      // didn't exist at the base (a brand-new file) has no graph node there; we
      // simply skip it. `buildStructureView` filters seeds through filesByPath
      // anyway, so passing all of `diffChanged` is harmless.
      const roots = anchorPath ? [anchorPath] : diffChanged;
      const view = await buildStructureView({ allPaths, changedPaths: roots, readSource, hops });
      // changedFiles signals diff-emphasis (blue tint). In anchor mode we only
      // emphasise diff-changed files that ended up in the anchor neighbourhood.
      const nodeSet = new Set(view.graph.nodes);
      const changedFiles = diffChanged.filter(p => nodeSet.has(p)).sort();
      return json({ ...view, changedFiles, anchorPath: anchorPath ?? undefined, side });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[/sessions/${params.id}/structure] ${message}`);
      return json({ error: message }, 500);
    }
  });
}

function parseSideParam(raw: string | null): "before" | "after" {
  return raw === "before" ? "before" : "after";
}

function parseHopsParam(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(4, Math.floor(n)));
}

// The call-graph counterpart to /structure: function→function edges instead
// of file→file, built from a one-hop callHierarchy walk around the changeset's
// callable symbols. Needs a language server for each touched language —
// languages without one contribute nothing (their files just don't appear).
// The work scales with files × symbols × LSP round-trips; we cap the number of
// changed files we process so a giant diff doesn't tie up the language server
// long enough for the browser to give up on the response.
const CALL_GRAPH_MAX_CHANGED_FILES = 40;
// `?anchorPath` (and optional `?anchorLine` / `?anchorCharacter`, LSP 0-based)
// narrow the walk to one seed instead of the changeset. With `anchorPath`
// alone the seeds are every callable symbol in that file; with `anchorLine`
// they're just the symbol the human pinned from the code-nav popover.
async function getCallGraph(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    try {
      const url = new URL(req.url);
      const anchorPath = (url.searchParams.get("anchorPath") || "").trim() || null;
      const anchorLine = parseIntegerParam(url.searchParams.get("anchorLine"));
      const anchorCharacter = parseIntegerParam(url.searchParams.get("anchorCharacter"));
      const diffBase = await ctx.worktreeOps.resolveDiffBase(meta.worktreePath, meta.baseBranch, meta.baseCommit);
      const diff = await ctx.worktreeOps.gitDiff(meta.worktreePath, diffBase);
      const allPaths = await ctx.worktreeOps.listWorktreeFiles(meta.worktreePath);
      const inWorktree = new Set(allPaths);

      let changedFiles: string[];
      let anchorSymbol: { path: string; line: number; character?: number } | undefined;
      let totalChangedFiles: number;
      let truncated: boolean;
      if (anchorPath && anchorLine !== null) {
        anchorSymbol = { path: anchorPath, line: anchorLine, character: anchorCharacter ?? undefined };
        changedFiles = [];
        truncated = false;
        totalChangedFiles = 0;
      } else if (anchorPath) {
        changedFiles = inWorktree.has(anchorPath) && structureLanguageOf(anchorPath) !== null ? [anchorPath] : [];
        truncated = false;
        totalChangedFiles = changedFiles.length;
      } else {
        const allChanged = parseChangedFilePaths(diff)
          .filter(p => inWorktree.has(p) && structureLanguageOf(p) !== null);
        truncated = allChanged.length > CALL_GRAPH_MAX_CHANGED_FILES;
        changedFiles = truncated ? allChanged.slice(0, CALL_GRAPH_MAX_CHANGED_FILES) : allChanged;
        totalChangedFiles = allChanged.length;
      }

      const view = await collectCallGraph({
        worktreePath: meta.worktreePath,
        changedFiles,
        anchorSymbol,
        languageOf: p => structureLanguageOf(p) ?? null,
      });
      return json({
        ...view, truncated, totalChangedFiles,
        anchorPath: anchorPath ?? undefined,
        anchorLine: anchorLine ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[/sessions/${params.id}/call-graph] ${message}`);
      return json({ error: message }, 500);
    }
  });
}

function parseIntegerParam(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

async function getFile(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const relPath = new URL(req.url).searchParams.get("path");
    if (!relPath || relPath.trim() === "") return json({ error: "path query is required" }, 400);
    const result = await ctx.worktreeOps.readWorktreeFile(meta.worktreePath, relPath);
    switch (result.kind) {
      case "text": return json({ path: relPath, content: result.content });
      case "binary": return json({ path: relPath, binary: true });
      case "too-large": return json({ path: relPath, tooLarge: true, size: result.size });
      case "not-found": return json({ error: "file not found" }, 404);
      case "not-a-file": return json({ error: "not a file" }, 400);
      case "denied": return json({ error: "path outside worktree" }, 403);
    }
  });
}

// A GitHub-style "permalink" to a worktree file (and optional line range): the
// blob URL of `path` at the worktree's current HEAD on the repo's `origin`
// remote. HEAD may not be pushed yet, so the link only resolves once the branch
// is — the response carries `branch` so the UI can say so. Returns
// `{ url: null, reason }` when there's no remote, the remote isn't a
// GitHub-shaped host, or HEAD can't be resolved; the UI then offers no link.
async function getPermalink(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const query = new URL(req.url).searchParams;
    const relPath = query.get("path");
    if (!relPath || relPath.trim() === "") return json({ error: "path query is required" }, 400);
    if (relPath.startsWith("/") || relPath.split("/").includes("..")) return json({ error: "path outside worktree" }, 400);
    const lineStart = parsePositiveIntParam(query.get("lineStart"));
    const lineEnd = parsePositiveIntParam(query.get("lineEnd"));

    const remoteUrl = await ctx.worktreeOps.gitRemoteUrl(meta.worktreePath);
    if (!remoteUrl) return json({ url: null, reason: "no-remote" });
    const repo = parseGitRemoteUrl(remoteUrl);
    if (!repo) return json({ url: null, reason: "unsupported-host" });
    const sha = await ctx.worktreeOps.gitHeadSha(meta.worktreePath);
    if (!sha) return json({ url: null, reason: "no-commit" });

    const url = buildBlobPermalink({
      webBaseUrl: repo.webBaseUrl,
      ref: sha,
      path: relPath,
      lineStart: lineStart ?? undefined,
      lineEnd: lineEnd ?? undefined,
    });
    return json({ url, ref: sha, branch: meta.branchName });
  });
}

function parsePositiveIntParam(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// Full-text search across the session worktree's files (the Files tab's Ctrl+F):
// the human types a query, picks a hit, and the Files tab opens that file.
async function getFileSearch(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const query = (new URL(req.url).searchParams.get("q") ?? "").trim();
    if (query === "") return json({ matches: [], truncated: false });
    const paths = await ctx.worktreeOps.listWorktreeFiles(meta.worktreePath);
    const { matches, truncated } = await searchFileContents(meta.worktreePath, paths, query);
    return json({ matches, truncated });
  });
}

// Code navigation (the Files tab's "go to definition / find references"): resolve
// the symbol at path:line:character via the language server registered for the
// given languageId. `{ available: false }` means no language server is available
// here (the frontend then falls back to its client-side heuristic); otherwise
// `{ available: true, locations }` (locations may be empty). line/character are
// 0-based, matching LSP.
function getCodeNavDefinition(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return codeNavQuery(req, ctx, params, findDefinition);
}

function getCodeNavReferences(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return codeNavQuery(req, ctx, params, findReferences);
}

function codeNavQuery(
  req: Request,
  ctx: ServerContext,
  params: Record<string, string>,
  resolveLocations: typeof findDefinition,
): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const url = new URL(req.url);
    const relPath = (url.searchParams.get("path") ?? "").trim();
    const language = (url.searchParams.get("language") ?? "").trim() || null;
    const line = Number(url.searchParams.get("line"));
    const character = Number(url.searchParams.get("character"));
    if (
      relPath === "" ||
      !url.searchParams.has("line") || !Number.isInteger(line) || line < 0 ||
      !url.searchParams.has("character") || !Number.isInteger(character) || character < 0
    ) {
      return json({ error: "path, line (>=0) and character (>=0) query params are required" }, 400);
    }
    const locations = await resolveLocations(meta.worktreePath, language, relPath, line, character);
    return locations === null ? json({ available: false }) : json({ available: true, locations });
  });
}

async function postStop(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    if (isTerminal(meta.status)) return json({ meta });
    const att = ctx.clients.get(meta.id);
    if (att) {
      await att.client.kill("SIGTERM");
      await Promise.race([
        att.client.exited,
        new Promise((r) => setTimeout(r, 500)),
      ]);
      if (ctx.clients.has(meta.id)) {
        await att.client.kill("SIGKILL");
        await att.client.exited.catch(() => {});
      }
    } else if (meta.hostPid !== undefined && isPidAlive(meta.hostPid)) {
      // Reconnect failed earlier (e.g. stale socket) but the host is alive.
      // Best-effort kill via PID.
      try { process.kill(meta.hostPid, "SIGTERM"); } catch {}
    }
    ctx.clients.delete(meta.id);
    const updated = await transitionStatus(ctx, meta, "stopped");
    await appendAndBroadcast(ctx, meta.id, { kind: "session_stopped", payload: { reason: "stop" } });
    return json({ meta: updated });
  });
}

// Manual wake: re-send the wake-stdin write that postFeedback/postEscalationResolve
// trigger as a side effect, without queueing any feedback. The escape hatch for
// the "host still says running but the agent stopped consuming stdin" case the
// 90s watchdog hasn't caught yet (or for nudging the agent the human just
// recovered from a wedged state). Does not touch session status.
async function postWake(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    if (isTerminal(meta.status)) {
      return json({ error: "session is terminal; nothing to wake" }, 400);
    }
    const att = ctx.clients.get(meta.id);
    appendHostLog(ctx, meta.id, "wake_sent", {
      hasClient: att !== undefined,
      status: meta.status,
      reason: "manual",
    });
    if (att) {
      att.client.send("[wake] check feedback inbox").catch(() => {});
      scheduleWakeWatchdog(ctx, meta.id, att);
    }
    return json({ ok: true, sent: att !== undefined });
  });
}

interface ResumeBody {
  prompt?: string;
}

// Resume a stopped/crashed session: respawn the host on its preserved
// worktree with `claude --continue` so the prior conversation carries over.
// An optional prompt is queued like ordinary feedback — the resumed agent
// picks it up via `worqload feedback fetch`.
async function postResume(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    if (!isTerminal(meta.status)) {
      return json({ error: "session is not stopped; nothing to resume" }, 400);
    }
    if (!meta.worktreePath || !existsSync(meta.worktreePath)) {
      return json({ error: "session worktree no longer exists; cannot resume" }, 400);
    }
    const body = (await req.json().catch(() => ({}))) as ResumeBody;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt !== "") {
      const inbox = feedbackInboxDirFor(ctx, meta.id);
      const file = await writeNumberedFile(inbox, "resume", prompt);
      await appendAndBroadcast(ctx, meta.id, { kind: "feedback_received", payload: { filename: file.filename } });
    }

    const { endedAt: _endedAt, archivedAt: _archivedAt, ...rest } = meta;
    const resumed: SessionMeta = { ...rest, status: "running" };
    await saveSessionMeta(resumed, ctx.sessionsDir);
    await spawnAndAttachHost(ctx, resumed, { resume: true });

    const stored = await loadSessionMeta(meta.id, ctx.sessionsDir);
    return json({ meta: stored ?? resumed });
  });
}

interface FeedbackBody {
  content: string;
  anchor?: { path: string; lineStart: number; lineEnd?: number };
  slug?: string;
}

async function postFeedback(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const body = (await req.json()) as FeedbackBody;
    if (!body || typeof body.content !== "string" || body.content === "") {
      return json({ error: "content is required" }, 400);
    }
    const slug = body.slug ?? "feedback";
    const writeOpts: WriteNumberedFileOptions = { archiveDirs: [feedbackReadDirFor(ctx, meta.id)] };
    if (body.anchor) {
      const { path, lineStart, lineEnd } = body.anchor;
      writeOpts.meta = { anchor: { path, lineStart, lineEnd: lineEnd && lineEnd > lineStart ? lineEnd : lineStart } };
    }
    const inbox = feedbackInboxDirFor(ctx, meta.id);
    const file = await writeNumberedFile(inbox, slug, body.content, writeOpts);
    await appendAndBroadcast(ctx, meta.id, { kind: "feedback_received", payload: { filename: file.filename } });

    // Wake the host's claude child if idle (fire-and-forget). The log entry
    // pairs with host-side stdin_write events so a "wake never reached claude"
    // failure can be triaged from a single file post-hoc.
    const att = ctx.clients.get(meta.id);
    appendHostLog(ctx, meta.id, "wake_sent", {
      filename: file.filename,
      seq: file.seq,
      hasClient: att !== undefined,
      status: meta.status,
    });
    if (att) {
      att.client.send("[wake] check feedback inbox").catch(() => {});
      scheduleWakeWatchdog(ctx, meta.id, att);
    }

    return json({ filename: file.filename, seq: file.seq });
  });
}

interface ResolveBody {
  content?: string;
  decision?: "approve" | "reject";
}

async function postEscalationResolve(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const askingDir = askingDirFor(ctx, meta.id);
    const askingFilePath = join(askingDir, params.filename);
    const askingFile = Bun.file(askingFilePath);
    if (!(await askingFile.exists())) {
      return json({ error: "escalation not found" }, 404);
    }

    const body = (await req.json().catch(() => ({}))) as ResolveBody;
    const sidecarPath = join(askingDir, commandSidecarFilename(params.filename));
    const sidecarFile = Bun.file(sidecarPath);
    const isCommandApproval = await sidecarFile.exists();
    const resolvedDir = join(askingDir, "resolved");

    let feedbackContent: string;
    let slug: string;
    let resolvedPayload: Record<string, unknown>;
    let runResult: ApprovedCommandResult | undefined;

    if (isCommandApproval) {
      const decision = body.decision;
      if (decision !== "approve" && decision !== "reject") {
        return json({ error: "decision must be 'approve' or 'reject'" }, 400);
      }
      let command = "";
      try { command = ((await sidecarFile.json()) as CommandApproval).command ?? ""; } catch { /* corrupt sidecar */ }
      await moveFile(askingFilePath, join(resolvedDir, params.filename));
      await moveFile(sidecarPath, join(resolvedDir, commandSidecarFilename(params.filename)));
      const note = typeof body.content === "string" ? body.content.trim() : "";
      if (decision === "approve") {
        runResult = await runApprovedCommand(command, meta.worktreePath);
        feedbackContent = formatApprovedCommandFeedback(params.filename, command, runResult, note);
      } else {
        feedbackContent = formatRejectedCommandFeedback(params.filename, command, note);
      }
      slug = `command-${decision}`;
      resolvedPayload = {
        filename: params.filename,
        decision,
        command,
        ...(note ? { note } : {}),
        ...(runResult
          ? {
              exitCode: runResult.exitCode,
              signal: runResult.signal,
              timedOut: runResult.timedOut,
              stdout: runResult.stdout,
              stderr: runResult.stderr,
            }
          : {}),
      };
    } else {
      if (typeof body.content !== "string" || body.content.trim() === "") {
        return json({ error: "content is required" }, 400);
      }
      const question = await askingFile.text();
      await moveFile(askingFilePath, join(resolvedDir, params.filename));
      feedbackContent =
        `Re: escalation ${params.filename}\n\n## Question\n\n${question.trim()}\n\n## Answer\n\n${body.content}`;
      slug = `answer-${params.filename.replace(/^\d+-/, "").replace(/\.md$/, "")}`;
      resolvedPayload = { filename: params.filename };
    }

    const inbox = feedbackInboxDirFor(ctx, meta.id);
    const file = await writeNumberedFile(inbox, slug, feedbackContent, {
      archiveDirs: [feedbackReadDirFor(ctx, meta.id)],
    });
    await appendAndBroadcast(ctx, meta.id, {
      kind: "escalation_resolved",
      payload: { ...resolvedPayload, answerFilename: file.filename },
    });
    await appendAndBroadcast(ctx, meta.id, {
      kind: "feedback_received",
      payload: { filename: file.filename },
    });

    // If no more pending escalations, return to running.
    const remaining = await listAllFiles(askingDir);
    let updatedMeta = meta;
    if (remaining.length === 0 && meta.status === "waiting_human") {
      updatedMeta = await transitionStatus(ctx, meta, "running");
    }

    const att = ctx.clients.get(meta.id);
    appendHostLog(ctx, meta.id, "wake_sent", {
      filename: file.filename,
      seq: file.seq,
      hasClient: att !== undefined,
      status: updatedMeta.status,
      reason: "escalation_resolved",
    });
    if (att) {
      att.client.send("[wake] check feedback inbox").catch(() => {});
      scheduleWakeWatchdog(ctx, meta.id, att);
    }

    return json({
      ok: true,
      answerFilename: file.filename,
      ...(isCommandApproval
        ? {
            decision: body.decision,
            ...(runResult ? { exitCode: runResult.exitCode, stdout: runResult.stdout, stderr: runResult.stderr } : {}),
          }
        : {}),
      meta: updatedMeta,
    });
  });
}

async function getActions(): Promise<Response> {
  return json({ actions: listActions() });
}

async function getSessionActions(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => json({ actions: listAvailableActions({ meta, repoDir: ctx.repoDir }) }));
}

interface ActionInvokeBody {
  params?: Record<string, string>;
}

async function postSessionAction(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const action = findAction(params.actionId);
    if (!action) return json({ error: `unknown action: ${params.actionId}` }, 404);
    const body = (await req.json().catch(() => ({}))) as ActionInvokeBody;
    const actionParams = body.params ?? {};
    const result = await action.run({ meta, repoDir: ctx.repoDir }, actionParams);
    // Persist the run (success or failure) so its output is reviewable later in
    // the events stream rather than living only in the response of one request.
    await appendAndBroadcast(ctx, meta.id, {
      kind: "action_invoked",
      payload: {
        actionId: action.id,
        label: action.label,
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        message: result.message,
      },
    });
    return json(
      {
        actionId: action.id,
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        message: result.message,
      },
      result.ok ? 200 : 422,
    );
  });
}

// -------- handlers: internal --------

interface NumberedBody {
  slug: string;
  content: string;
  // Reports only: the feedback message this report answers (see `--re`).
  replyTo?: string;
}

const NUMBERED_FILENAME_RE = /^\d+-[A-Za-z0-9_-]+\.md$/;

async function postInternalReports(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const body = (await req.json()) as NumberedBody;
    if (!body?.slug || typeof body.content !== "string") {
      return json({ error: "slug and content required" }, 400);
    }
    const replyTo = typeof body.replyTo === "string" && body.replyTo !== "" ? body.replyTo : undefined;
    if (replyTo) {
      if (!NUMBERED_FILENAME_RE.test(replyTo)) {
        return json({ error: `--re must be a feedback filename like 003-feedback.md, got: ${replyTo}` }, 400);
      }
      const inInbox = await Bun.file(join(feedbackInboxDirFor(ctx, meta.id), replyTo)).exists();
      const inRead = await Bun.file(join(feedbackReadDirFor(ctx, meta.id), replyTo)).exists();
      if (!inInbox && !inRead) {
        return json({ error: `no such feedback message: ${replyTo}` }, 400);
      }
    }
    const dir = reportsDirFor(ctx, meta.id);
    const file = await writeNumberedFile(dir, body.slug, body.content, replyTo ? { meta: { replyTo } } : {});
    await appendAndBroadcast(ctx, meta.id, { kind: "report_submitted", payload: { filename: file.filename } });
    return json({ filename: file.filename, seq: file.seq });
  });
}

async function postInternalEscalations(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const body = (await req.json()) as NumberedBody;
    if (!body?.slug || typeof body.content !== "string") {
      return json({ error: "slug and content required" }, 400);
    }
    const dir = askingDirFor(ctx, meta.id);
    const file = await writeNumberedFile(dir, body.slug, body.content, {
      archiveDirs: [join(dir, "resolved")],
    });
    if (!isTerminal(meta.status) && meta.status !== "waiting_human") {
      await transitionStatus(ctx, meta, "waiting_human");
    }
    await appendAndBroadcast(ctx, meta.id, { kind: "escalation_requested", payload: { filename: file.filename } });
    return json({ filename: file.filename, seq: file.seq });
  });
}

interface CommandApprovalBody {
  command: string;
  reason?: string;
}

// The agent asks the human to approve running a command outside its allowlist
// (`worqload escalate command`). Stored like an escalation — an `asking/*.md`
// plus a `.command.json` sidecar — so it shows up in the same waiting_human
// flow; the resolve endpoint then runs (or refuses) the command and feeds the
// result back via the inbox.
async function postInternalCommandApprovals(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const body = (await req.json()) as CommandApprovalBody;
    if (!body || typeof body.command !== "string" || body.command.trim() === "") {
      return json({ error: "command is required" }, 400);
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const dir = askingDirFor(ctx, meta.id);
    const file = await writeNumberedFile(dir, "command-approval", buildCommandApprovalMarkdown(body.command, reason), {
      archiveDirs: [join(dir, "resolved")],
    });
    await Bun.write(join(dir, commandSidecarFilename(file.filename)), JSON.stringify({ command: body.command, ...(reason ? { reason } : {}) }, null, 2));
    if (!isTerminal(meta.status) && meta.status !== "waiting_human") {
      await transitionStatus(ctx, meta, "waiting_human");
    }
    await appendAndBroadcast(ctx, meta.id, {
      kind: "escalation_requested",
      payload: { filename: file.filename, command: body.command },
    });
    return json({ filename: file.filename, seq: file.seq });
  });
}

async function getInternalFeedback(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const inbox = feedbackInboxDirFor(ctx, meta.id);
    const readDir = feedbackReadDirFor(ctx, meta.id);
    const messages = await listAllFiles(inbox);
    for (const m of messages) {
      await moveNumberedFile(inbox, readDir, m.filename);
    }
    if (messages.length > 0) {
      await appendAndBroadcast(ctx, meta.id, { kind: "feedback_fetched", payload: { count: messages.length } });
    }
    return json({
      messages: messages.map(m => ({
        filename: m.filename,
        // The anchor lives in a sidecar now; re-derive the `Re:` line the agent
        // is told to expect at the head of an anchored message.
        content: m.meta?.anchor ? `${formatAnchorRefLine(m.meta.anchor)}\n\n${m.content}` : m.content,
      })),
    });
  });
}
