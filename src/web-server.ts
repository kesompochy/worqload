import type { Server, ServerWebSocket } from "bun";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createSession,
  saveSessionMeta,
  loadSessionMeta,
  listSessionMetas,
  isTerminal,
  validateTransition,
  type SessionMeta,
  type SessionStatus,
} from "./session";
import { startSessionRunner, type SessionRunner } from "./session-runner";
import { appendEvent, readEvents } from "./event-log";
import { createSessionWorktree, removeWorktree, resolveBaseCommit, currentBranch, gitDiff } from "./worktree";
import { writeNumberedFile, listAllFiles, moveFile } from "./file-store";
import { listActions, findAction } from "./actions";

// worqload protocol commands are part of the system contract; they must run
// without permission prompts regardless of which permission mode the rest of
// the session uses.
const WORQLOAD_PROTOCOL_ALLOW =
  "Bash(worqload report submit:*) Bash(worqload escalate submit:*) " +
  "Bash(worqload feedback fetch) Bash(worqload feedback fetch:*)";

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

// Prepended to the first user message so the agent learns the worqload
// protocol without depending on user-side .claude/skills/ setup.
const PROTOCOL_PREFIX = `You are running inside a worqload session.

Communication protocol with the human:
- The human does not read your raw turn-by-turn chat. They read **reports** you submit, in a timeline UI.
- Submit a report at every meaningful checkpoint: plan formed, before and after long tool calls, on completion of a logical unit, on rising uncertainty, at task completion. A session with zero reports is a session that did nothing visible.
- A report is markdown. State what you observed, what you decided, and what you did, in that order. Do not paste raw tool output without summary.

Commands available to you (already on PATH inside this session):
- \`worqload report submit --slug <slug>\`        body via stdin; submits a report
- \`worqload escalate submit --slug <slug>\`      body via stdin; asks the human a question and pauses your turn
- \`worqload feedback fetch\`                     drains pending human feedback to stdout

Polling discipline:
- At the start of every turn, run \`worqload feedback fetch\` first. If non-empty, treat each message as new instruction.
- Before and after long-running tool calls, run \`worqload feedback fetch\` again.

Anchors in feedback: a feedback message may begin with \`Re: <path>:<lineStart>-<lineEnd>\\n\\n...\`. The path is relative to your CWD. \`./.worqload-reports/<filename>\` points at your own past reports — Read them when referenced.

Files:
- CWD is a git worktree branched from the human's base branch. Edit code here freely.
- worqload does NOT merge or commit. The human handles git workflow themselves.

Your task follows. Begin by submitting a brief plan report, then start work.

---

`;

interface WsClientData {
  sessionId: string;
}

export interface ServerContext {
  port: number;
  repoDir: string;
  worqloadDir: string;          // <repo>/.worqload
  sessionsDir: string;          // <repo>/.worqload/sessions
  worktreesDir: string;         // <repo>/.worktrees
  spawnCommand: string[];
  runners: Map<string, SessionRunner>;
  baseUrlForAgent: string;
  wsClients: Set<ServerWebSocket<WsClientData>>;
}

export interface StartServerOptions {
  port?: number;                // 0 = random
  repoDir?: string;
  spawnCommand?: string[];      // override the claude binary command
}

export interface StartedServer {
  server: Server;
  ctx: ServerContext;
  shutdown(): Promise<void>;
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

function buildUserMessage(text: string): unknown {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

async function sendUserText(runner: SessionRunner, text: string): Promise<void> {
  await runner.send(buildUserMessage(text));
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

async function spawnAndAttach(ctx: ServerContext, meta: SessionMeta): Promise<SessionRunner> {
  const runner = startSessionRunner({
    sessionId: meta.id,
    sessionsDir: ctx.sessionsDir,
    cwd: meta.worktreePath,
    command: ctx.spawnCommand,
    env: {
      WORQLOAD_SESSION_ID: meta.id,
      WORQLOAD_ENDPOINT: ctx.baseUrlForAgent,
    },
    onEvent: event => broadcastEvent(ctx, meta.id, event),
  });

  ctx.runners.set(meta.id, runner);
  await saveSessionMeta({ ...meta, pid: runner.pid }, ctx.sessionsDir);

  // Detach: when the process exits and the session has not been moved to a
  // terminal status by Stop / Cancel, mark it crashed (non-zero exit) or
  // stopped (zero exit). Errors here are swallowed because the session dir
  // may have been removed underneath us (e.g. test cleanup, manual rm).
  void runner.exited.then(async exitCode => {
    try {
      ctx.runners.delete(meta.id);
      const current = await loadSessionMeta(meta.id, ctx.sessionsDir);
      if (!current || isTerminal(current.status)) return;
      const next: SessionStatus = exitCode === 0 ? "stopped" : "crashed";
      await saveSessionMeta(
        { ...current, status: next, endedAt: new Date().toISOString() },
        ctx.sessionsDir,
      );
    } catch {
      // session metadata directory may be gone (e.g. cancelled / cleanup)
    }
  });

  // Initial user message = protocol prefix + the session prompt.
  await sendUserText(runner, PROTOCOL_PREFIX + meta.prompt);

  await appendAndBroadcast(ctx, meta.id, { kind: "session_started", payload: { prompt: meta.prompt } });

  return runner;
}

export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const repoDir = resolve(opts.repoDir ?? process.cwd());
  const worqloadDir = join(repoDir, ".worqload");
  const sessionsDir = join(worqloadDir, "sessions");
  const worktreesDir = join(repoDir, ".worktrees");
  const spawnCommand = opts.spawnCommand ?? buildDefaultSpawnCommand();

  await mkdir(sessionsDir, { recursive: true });

  // ctx is assigned right after Bun.serve returns; the fetch handler
  // captures the binding and only reads it when a request arrives, by which
  // point the assignment below has run.
  let ctx!: ServerContext;

  const server = Bun.serve<WsClientData, undefined>({
    hostname: "127.0.0.1",
    port: opts.port ?? 3456,
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
  });

  ctx = {
    repoDir,
    worqloadDir,
    sessionsDir,
    worktreesDir,
    spawnCommand,
    runners: new Map(),
    port: server.port,
    baseUrlForAgent: `http://127.0.0.1:${server.port}`,
    wsClients: new Set(),
  };

  await reconcileOrphanSessions(ctx);

  async function shutdown(): Promise<void> {
    for (const runner of ctx.runners.values()) {
      try { runner.kill("SIGKILL"); } catch {}
      await runner.exited.catch(() => {});
    }
    ctx.runners.clear();
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
  defineRoute("POST", "/sessions", postSessions),
  defineRoute("GET",  "/sessions", getSessions),
  defineRoute("GET",  "/sessions/:id", getSessionDetail),
  defineRoute("POST", "/sessions/:id/stop", postStop),
  defineRoute("POST", "/sessions/:id/cancel", postCancel),
  defineRoute("POST", "/sessions/:id/archive", postArchive),
  defineRoute("POST", "/sessions/:id/feedback", postFeedback),
  defineRoute("GET",  "/sessions/:id/feedback", getFeedbackHistory),
  defineRoute("POST", "/sessions/:id/escalations/:filename/resolve", postEscalationResolve),
  defineRoute("GET",  "/sessions/:id/reports", getReports),
  defineRoute("GET",  "/sessions/:id/asking", getAsking),
  defineRoute("GET",  "/sessions/:id/diff", getDiff),
  defineRoute("GET",  "/actions", getActions),
  defineRoute("POST", "/sessions/:id/actions/:actionId", postSessionAction),
  defineRoute("POST", "/internal/sessions/:id/reports", postInternalReports),
  defineRoute("POST", "/internal/sessions/:id/escalations", postInternalEscalations),
  defineRoute("GET",  "/internal/sessions/:id/feedback", getInternalFeedback),
];

const INDEX_HTML_PATH = join(import.meta.dir, "..", "web", "index.html");

async function getIndex(): Promise<Response> {
  return new Response(Bun.file(INDEX_HTML_PATH), {
    headers: { "content-type": "text/html; charset=utf-8" },
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

// On server start, sessions with status running or waiting_human are orphans:
// the server that owned their stdio is gone, so the human can no longer
// interact with them. Kill the lingering process (if any) and mark crashed.
async function reconcileOrphanSessions(ctx: ServerContext): Promise<void> {
  const all = await listSessionMetas(ctx.sessionsDir);
  for (const meta of all) {
    if (isTerminal(meta.status)) continue;
    if (meta.pid !== undefined && isPidAlive(meta.pid)) {
      try { process.kill(meta.pid, "SIGKILL"); } catch {}
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
}

async function postSessions(req: Request, ctx: ServerContext): Promise<Response> {
  const body = (await req.json()) as PostSessionsBody;
  if (!body || typeof body.prompt !== "string" || body.prompt.trim() === "") {
    return json({ error: "prompt is required" }, 400);
  }

  const baseBranch = body.baseBranch?.trim() || (await currentBranch(ctx.repoDir));
  const baseCommit = await resolveBaseCommit(baseBranch, ctx.repoDir);

  const tentative = createSession({
    prompt: body.prompt,
    baseBranch,
    baseCommit,
    worktreePath: "",   // filled in below
    title: body.title,
  });

  const reportsDir = reportsDirFor(ctx, tentative.id);
  const { worktreePath } = await createSessionWorktree({
    sessionId: tentative.id,
    repoDir: ctx.repoDir,
    baseBranch,
    reportsDirAbsolute: reportsDir,
  });

  const meta: SessionMeta = { ...tentative, worktreePath };
  await saveSessionMeta(meta, ctx.sessionsDir);
  await spawnAndAttach(ctx, meta);

  const stored = await loadSessionMeta(meta.id, ctx.sessionsDir);
  return json({ meta: stored ?? meta }, 201);
}

async function getSessions(req: Request, ctx: ServerContext): Promise<Response> {
  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("includeArchived") === "true";
  const sessions = await listSessionMetas(ctx.sessionsDir);
  const filtered = includeArchived ? sessions : sessions.filter(s => !s.archivedAt);
  return json({ sessions: filtered });
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
    const reports = await listAllFiles(reportsDirFor(ctx, meta.id));
    return json({
      reports: reports.map(r => ({ filename: r.filename, content: r.content })),
    });
  });
}

async function getAsking(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const asking = await listAllFiles(askingDirFor(ctx, meta.id));
    return json({
      asking: asking.map(a => ({ filename: a.filename, content: a.content })),
    });
  });
}

async function getDiff(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const url = new URL(req.url);
    const base = url.searchParams.get("base") || "session-start";
    const target = base === "base-branch" ? meta.baseBranch : meta.baseCommit;
    try {
      const diff = await gitDiff(meta.worktreePath, target);
      return new Response(diff, { headers: { "content-type": "text/plain; charset=utf-8" } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  });
}

async function postStop(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    if (isTerminal(meta.status)) return json({ meta });
    const runner = ctx.runners.get(meta.id);
    if (runner) {
      runner.kill("SIGTERM");
      await Promise.race([
        runner.exited,
        new Promise(r => setTimeout(r, 500)),
      ]);
      if (runner.pid !== undefined && ctx.runners.has(meta.id)) {
        try { runner.kill("SIGKILL"); } catch {}
        await runner.exited.catch(() => {});
      }
    }
    const updated = await transitionStatus(ctx, meta, "stopped");
    await appendAndBroadcast(ctx, meta.id, { kind: "session_stopped", payload: { reason: "stop" } });
    return json({ meta: updated });
  });
}

async function postCancel(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const runner = ctx.runners.get(meta.id);
    if (runner) {
      try { runner.kill("SIGKILL"); } catch {}
      await runner.exited.catch(() => {});
    }
    if (meta.worktreePath) {
      try {
        const branchName = `worqload/${meta.id.slice(0, 8)}`;
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

    // Wake the runner if idle (fire-and-forget)
    const runner = ctx.runners.get(meta.id);
    if (runner) {
      sendUserText(runner, "[wake] check feedback inbox").catch(() => {});
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

    const runner = ctx.runners.get(meta.id);
    if (runner) {
      sendUserText(runner, "[wake] check feedback inbox").catch(() => {});
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
