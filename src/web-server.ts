import type { Server, ServerWebSocket, Subprocess } from "bun";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import {
  agentEndpointPath,
  createSession,
  saveSessionMeta,
  loadSessionMeta,
  listSessionMetas,
  isTerminal,
  validateTransition,
  type SessionMeta,
  type SessionStatus,
} from "./session";
import { connectToHost, type HostClient, spawnDetachedHost } from "./session-host-client";
import { appendEvent, readEvents } from "./event-log";
import {
  createSessionWorktree,
  removeWorktree,
  resolveBaseCommit,
  currentBranch,
  gitDiff,
  listWorktreeFiles,
  readWorktreeFile,
} from "./worktree";
import { writeNumberedFile, listAllFiles, moveFile, readReadState, setReadState } from "./file-store";
import { listActions, findAction } from "./actions";
import { defaultBranchNameGenerator, sanitizeBranchName, type BranchNameGenerator } from "./branch-name";

// worqload protocol commands are part of the system contract; they must run
// without permission prompts regardless of which permission mode the rest of
// the session uses.
const WORQLOAD_PROTOCOL_ALLOW =
  "Bash(worqload report submit:*) Bash(worqload escalate submit:*) " +
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

function buildDefaultSpawnCommand(): string[] {
  // bypassPermissions is the default for v1 ergonomics: a -p session has no
  // human to approve prompts, so any unallowed Bash would auto-fail. Set
  // WORQLOAD_PERMISSION_MODE=default (or acceptEdits) to lock the session
  // down to only the protocol allowlist above (the agent will then be able
  // to write reports etc. but not run arbitrary dev commands).
  const permissionMode = process.env.WORQLOAD_PERMISSION_MODE || "bypassPermissions";
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
  // Defined only when this serve instance is the one that spawned the host.
  hostProc?: Subprocess;
}

export interface ServerContext {
  port: number;
  repoDir: string;
  worqloadDir: string;          // <repo>/.worqload
  sessionsDir: string;          // <repo>/.worqload/sessions
  worktreesDir: string;         // <repo>/.worktrees
  spawnCommand: string[];
  branchNameGenerator: BranchNameGenerator;
  hostCommand: string[];
  clients: Map<string, SessionAttachment>;
  baseUrlForAgent: string;
  wsClients: Set<ServerWebSocket<WsClientData>>;
}

export interface StartServerOptions {
  port?: number;                // 0 = random
  repoDir?: string;
  spawnCommand?: string[];      // override the claude binary command
  // Overrides the helper that turns a prompt into a short branch name.
  // Return null to skip generation; the caller then falls back to <shortId>.
  branchNameGenerator?: BranchNameGenerator;
  hostCommand?: string[];       // override how the host process itself is launched
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

// Spawn a detached host and connect to it. The host (not serve) writes the
// session_started / session_resumed event and the first user message. On
// resume the prior claude conversation is continued (`--continue`) and the
// host replays the existing event log to us, so we connect from seq 0 too.
async function spawnAndAttachHost(
  ctx: ServerContext,
  meta: SessionMeta,
  opts: { resume?: boolean } = {},
): Promise<HostClient> {
  const socketPath = hostSocketPathFor(meta.id);
  await writeAgentEndpointFile(ctx, meta.id);
  const hostProc = spawnDetachedHost({
    sessionId: meta.id,
    sessionsDir: ctx.sessionsDir,
    socketPath,
    agentEndpoint: ctx.baseUrlForAgent,
    spawnCommand: opts.resume ? [...ctx.spawnCommand, "--continue"] : ctx.spawnCommand,
    hostCommand: ctx.hostCommand,
    ...(opts.resume && { resume: true }),
  });

  const client = await connectToHost({
    socketPath,
    sinceSeq: 0,
    onEvent: (event) => broadcastEvent(ctx, meta.id, event),
    onDisconnect: () => {
      ctx.clients.delete(meta.id);
    },
  });
  await client.replayCompleted.catch(() => {});

  ctx.clients.set(meta.id, { client, hostProc, hostPid: hostProc.pid });
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
  const spawnCommand = opts.spawnCommand ?? buildDefaultSpawnCommand();
  const branchNameGenerator = opts.branchNameGenerator ?? defaultBranchNameGenerator;
  const hostCommand = opts.hostCommand ?? buildDefaultHostCommand();

  await mkdir(sessionsDir, { recursive: true });

  // ctx is assigned right after Bun.serve returns; the fetch handler
  // captures the binding and only reads it when a request arrives, by which
  // point the assignment below has run.
  let ctx!: ServerContext;

  const server = listenWithFallback(opts.port ?? 3456, port => Bun.serve<WsClientData, undefined>({
    hostname: "127.0.0.1",
    port,
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
    hostCommand,
    clients: new Map(),
    port: server.port,
    baseUrlForAgent: `http://127.0.0.1:${server.port}`,
    wsClients: new Set(),
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
  defineRoute("GET",  "/assets/:filename", getAsset),
  defineRoute("GET",  "/meta", getMeta),
  defineRoute("POST", "/sessions", postSessions),
  defineRoute("GET",  "/sessions", getSessions),
  defineRoute("GET",  "/sessions/:id", getSessionDetail),
  defineRoute("POST", "/sessions/:id/stop", postStop),
  defineRoute("POST", "/sessions/:id/cancel", postCancel),
  defineRoute("POST", "/sessions/:id/resume", postResume),
  defineRoute("POST", "/sessions/:id/archive", postArchive),
  defineRoute("POST", "/sessions/:id/feedback", postFeedback),
  defineRoute("GET",  "/sessions/:id/feedback", getFeedbackHistory),
  defineRoute("POST", "/sessions/:id/escalations/:filename/resolve", postEscalationResolve),
  defineRoute("GET",  "/sessions/:id/reports", getReports),
  defineRoute("POST", "/sessions/:id/reports/:filename/read", postReportRead),
  defineRoute("POST", "/sessions/:id/reports/:filename/unread", postReportUnread),
  defineRoute("GET",  "/sessions/:id/asking", getAsking),
  defineRoute("GET",  "/sessions/:id/diff", getDiff),
  defineRoute("GET",  "/sessions/:id/files", getFiles),
  defineRoute("GET",  "/sessions/:id/file", getFile),
  defineRoute("GET",  "/actions", getActions),
  defineRoute("POST", "/sessions/:id/actions/:actionId", postSessionAction),
  defineRoute("POST", "/internal/sessions/:id/reports", postInternalReports),
  defineRoute("POST", "/internal/sessions/:id/escalations", postInternalEscalations),
  defineRoute("GET",  "/internal/sessions/:id/feedback", getInternalFeedback),
];

const WEB_DIR = join(import.meta.dir, "..", "web");
const INDEX_HTML_PATH = join(WEB_DIR, "index.html");

async function getIndex(): Promise<Response> {
  return new Response(Bun.file(INDEX_HTML_PATH), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Explicit whitelist of files served from /assets/:filename. We avoid shipping
// the whole web/ directory because directory traversal protection is easier to
// reason about with a closed list of basenames.
const ASSET_FILENAMES = [
  "style.css",
  "app.js",
  "dom.js",
  "state.js",
  "diff-view.js",
  "files-view.js",
  "actions-view.js",
  "markdown.js",
  "syntax-highlight.js",
  "notifications.js",
] as const;

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const ASSETS = new Map<string, { path: string; contentType: string }>(
  ASSET_FILENAMES.map((name) => [
    name,
    { path: join(WEB_DIR, name), contentType: ASSET_CONTENT_TYPES[extname(name)] ?? "application/octet-stream" },
  ]),
);

async function getMeta(_req: Request, ctx: ServerContext): Promise<Response> {
  return json({ repoDir: ctx.repoDir, repoName: basename(ctx.repoDir) });
}

async function getAsset(_req: Request, _ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  const entry = ASSETS.get(params.filename);
  if (!entry) return new Response("not found", { status: 404 });
  return new Response(Bun.file(entry.path), {
    headers: { "content-type": entry.contentType },
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

  const baseBranch = body.baseBranch?.trim() || (await currentBranch(ctx.repoDir));
  const baseCommit = await resolveBaseCommit(baseBranch, ctx.repoDir);

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
    ({ worktreePath } = await createSessionWorktree({
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
  const includeArchived = url.searchParams.get("includeArchived") === "true";
  const sessions = await listSessionMetas(ctx.sessionsDir);
  const filtered = includeArchived ? sessions : sessions.filter(s => !s.archivedAt);
  const decorated = await Promise.all(filtered.map(async meta => {
    const dir = reportsDirFor(ctx, meta.id);
    const [reports, readSet] = await Promise.all([listAllFiles(dir), readReadState(dir)]);
    const unreadReportCount = reports.reduce((n, r) => n + (readSet.has(r.filename) ? 0 : 1), 0);
    return { ...meta, unreadReportCount };
  }));
  return json({ sessions: decorated });
}

async function postArchive(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    if (!isTerminal(meta.status)) {
      return json({ error: "stop or cancel the session before archiving" }, 400);
    }
    if (meta.archivedAt) return json({ meta });
    const updated: SessionMeta = { ...meta, archivedAt: new Date().toISOString() };
    await saveSessionMeta(updated, ctx.sessionsDir);
    return json({ meta: updated });
  });
}

async function getFeedbackHistory(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const inbox = await listAllFiles(feedbackInboxDirFor(ctx, meta.id));
    const read = await listAllFiles(feedbackReadDirFor(ctx, meta.id));
    const all = [
      ...inbox.map(f => ({ filename: f.filename, content: f.content, status: "unread" as const })),
      ...read.map(f => ({ filename: f.filename, content: f.content, status: "read" as const })),
    ];
    all.sort((a, b) => a.filename.localeCompare(b.filename));
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

async function postReportUnread(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return setReportReadFlag(ctx, params, false);
}

async function getAsking(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const asking = await listAllFiles(askingDirFor(ctx, meta.id));
    return json({
      asking: asking.map(a => ({ filename: a.filename, content: a.content })),
    });
  });
}

// We hand the full file content (every unchanged line) to the browser so the
// diff view can let the human expand context locally without another round
// trip. -U with a value larger than any realistic file effectively means "all".
const FULL_FILE_CONTEXT_LINES = 1_000_000;

async function getDiff(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const url = new URL(req.url);
    const base = url.searchParams.get("base") || "session-start";
    const target = base === "base-branch" ? meta.baseBranch : meta.baseCommit;
    try {
      const diff = await gitDiff(meta.worktreePath, target, FULL_FILE_CONTEXT_LINES);
      return new Response(diff, { headers: { "content-type": "text/plain; charset=utf-8" } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  });
}

async function getFiles(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const paths = await listWorktreeFiles(meta.worktreePath);
    return json({ paths });
  });
}

async function getFile(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const relPath = new URL(req.url).searchParams.get("path");
    if (!relPath || relPath.trim() === "") return json({ error: "path query is required" }, 400);
    const result = await readWorktreeFile(meta.worktreePath, relPath);
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

async function postCancel(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const att = ctx.clients.get(meta.id);
    if (att) {
      await att.client.kill("SIGKILL");
      await att.client.exited.catch(() => {});
    } else if (meta.hostPid !== undefined && isPidAlive(meta.hostPid)) {
      try { process.kill(meta.hostPid, "SIGKILL"); } catch {}
    }
    ctx.clients.delete(meta.id);
    if (meta.worktreePath) {
      try {
        const branchName = meta.branchName || `worqload/${meta.id.slice(0, 8)}`;
        await removeWorktree(meta.worktreePath, branchName, ctx.repoDir);
      } catch {}
    }
    const updated = isTerminal(meta.status)
      ? meta
      : await transitionStatus(ctx, meta, "stopped");
    await appendAndBroadcast(ctx, meta.id, { kind: "session_stopped", payload: { reason: "cancel" } });
    return json({ meta: updated });
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
      return json({ error: "session worktree no longer exists (it was cancelled); cannot resume" }, 400);
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
    let content = body.content;
    if (body.anchor) {
      const { path, lineStart, lineEnd } = body.anchor;
      const range = lineEnd && lineEnd !== lineStart ? `${lineStart}-${lineEnd}` : `${lineStart}`;
      content = `Re: ${path}:${range}\n\n${content}`;
    }
    const inbox = feedbackInboxDirFor(ctx, meta.id);
    const file = await writeNumberedFile(inbox, slug, content);
    await appendAndBroadcast(ctx, meta.id, { kind: "feedback_received", payload: { filename: file.filename } });

    // Wake the host's claude child if idle (fire-and-forget)
    const att = ctx.clients.get(meta.id);
    if (att) {
      att.client.send("[wake] check feedback inbox").catch(() => {});
    }

    return json({ filename: file.filename, seq: file.seq });
  });
}

interface ResolveBody {
  content: string;
}

async function postEscalationResolve(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const body = (await req.json()) as ResolveBody;
    if (!body || typeof body.content !== "string" || body.content.trim() === "") {
      return json({ error: "content is required" }, 400);
    }

    const askingDir = askingDirFor(ctx, meta.id);
    const askingFilePath = join(askingDir, params.filename);
    const askingFile = Bun.file(askingFilePath);
    if (!(await askingFile.exists())) {
      return json({ error: "escalation not found" }, 404);
    }
    const question = await askingFile.text();

    const resolvedDir = join(askingDir, "resolved");
    await moveFile(askingFilePath, join(resolvedDir, params.filename));

    const inbox = feedbackInboxDirFor(ctx, meta.id);
    const slug = `answer-${params.filename.replace(/^\d+-/, "").replace(/\.md$/, "")}`;
    const feedbackContent =
      `Re: escalation ${params.filename}\n\n## Question\n\n${question.trim()}\n\n## Answer\n\n${body.content}`;
    const file = await writeNumberedFile(inbox, slug, feedbackContent);
    await appendAndBroadcast(ctx, meta.id, {
      kind: "escalation_resolved",
      payload: { filename: params.filename, answerFilename: file.filename },
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
    if (att) {
      att.client.send("[wake] check feedback inbox").catch(() => {});
    }

    return json({ ok: true, answerFilename: file.filename, meta: updatedMeta });
  });
}

async function getActions(): Promise<Response> {
  return json({ actions: listActions() });
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
}

async function postInternalReports(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const body = (await req.json()) as NumberedBody;
    if (!body?.slug || typeof body.content !== "string") {
      return json({ error: "slug and content required" }, 400);
    }
    const dir = reportsDirFor(ctx, meta.id);
    const file = await writeNumberedFile(dir, body.slug, body.content);
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
    const file = await writeNumberedFile(dir, body.slug, body.content);
    if (!isTerminal(meta.status) && meta.status !== "waiting_human") {
      await transitionStatus(ctx, meta, "waiting_human");
    }
    await appendAndBroadcast(ctx, meta.id, { kind: "escalation_requested", payload: { filename: file.filename } });
    return json({ filename: file.filename, seq: file.seq });
  });
}

async function getInternalFeedback(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const inbox = feedbackInboxDirFor(ctx, meta.id);
    const readDir = feedbackReadDirFor(ctx, meta.id);
    const messages = await listAllFiles(inbox);
    for (const m of messages) {
      await moveFile(m.path, join(readDir, m.filename));
    }
    if (messages.length > 0) {
      await appendAndBroadcast(ctx, meta.id, { kind: "feedback_fetched", payload: { count: messages.length } });
    }
    return json({
      messages: messages.map(m => ({ filename: m.filename, content: m.content })),
    });
  });
}
