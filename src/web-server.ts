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
  isReviseModeEnabled,
  validateTransition,
  type AgentName,
  type DriverName,
  type SessionMeta,
  type SessionStatus,
} from "./session";
import { makeClaudeReportRewriter, makeCodexReportRewriter, makeCursorReportRewriter, type ReportRewriter } from "./report-rewriter";
import { connectToHost, type HostClient, spawnDetachedHost } from "./session-host-client";
import { appendEvent, readEvents, type Event } from "./event-log";
import { realWorktreeOps, searchFileContents, type WorktreeOps } from "./worktree";
import { collectCallGraph, findDefinition, findReferences, shutdownAllLanguageServers } from "./language-servers";
import { buildStructureView, parseChangedFilePaths, structureLanguageOf } from "./structure-view";
import { parseGitRemoteUrl, buildBlobPermalink } from "./permalink";
import { ghPrLinkResolver, makeCachedPrLinkResolver, type PrLinkResolver } from "./pr-link";
import { writeNumberedFile, listAllFiles, moveFile, moveNumberedFile, deleteNumberedFile, readReadState, setReadState, markAllRead, attachmentsDirNameFor } from "./file-store";
import type { WriteNumberedFileOptions } from "./file-store";
import { formatAnchorRefLine } from "./anchor-ref";
import { backfillFeedbackAnchors } from "./feedback-anchor-backfill";
import { isSessionPreviewAlive, listActions, listAvailableActions, findAction, stopSessionPreview } from "./actions";
import { buildWebFrontend, webFrontendBuilt } from "./web-build";
import { defaultBranchNameGenerator, sanitizeBranchName, type BranchNameGenerator } from "./branch-name";
import { isAgentWorkEvent } from "../web/events-view.js";
import { TURN_WITHOUT_REPORT_NUDGE } from "./session-bootstrap";
import type { IpadicFeatures, Tokenizer } from "kuromoji";
import { defaultConfigPath, getTextlintTokenizer, lintReport, loadReviseFeedbackGuidance, loadTextlintRules, type TextlintRule, type TextlintViolation } from "./textlint";
import { expandSkillReferences, loadSkillButtons, type SkillButton } from "./skill-buttons";
import revisionRequestScaffold from "./prompts/revision-request-feedback.txt" with { type: "text" };

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

export function buildDefaultSpawnCommand(
  agentName: AgentName,
  driverName: DriverName,
  model?: string,
): string[] {
  if (agentName === "codex") {
    // The codex driver appends `exec --json -` (fresh) or `exec --json resume
    // <id> -` (subsequent turns) to this prefix. --dangerously-bypass-approvals-
    // and-sandbox is the codex equivalent of claude's bypassPermissions: a
    // headless worqload session has no human to approve a per-command prompt,
    // so the alternative is sessions wedging mid-turn.
    return ["codex", "--dangerously-bypass-approvals-and-sandbox"];
  }
  if (agentName === "cursor") {
    // The cursor driver appends the prompt (and `--resume <session_id>` on
    // follow-ups). --force auto-approves tool calls; --trust skips workspace
    // trust prompts in headless mode — both are required for unattended hosts.
    return ["agent", "-p", "--output-format", "stream-json", "--force", "--trust"];
  }
  // bypassPermissions is the default for v1 ergonomics: a -p session has no
  // human to approve prompts, so any unallowed Bash would auto-fail. Set
  // WORQLOAD_PERMISSION_MODE=default (or acceptEdits) to lock the session
  // down to only the protocol allowlist above (the agent will then be able
  // to write reports etc. but not run arbitrary dev commands).
  const permissionMode = process.env.WORQLOAD_PERMISSION_MODE || "bypassPermissions";
  const modelArgs = agentName === "claude" && model ? ["--model", model] : [];
  if (driverName === "tmux") {
    // The tmux driver runs interactive `claude` inside a detached tmux session
    // (see src/session-driver-tmux.ts). Interactive mode does not understand
    // --input-format or --output-format; `--dangerously-skip-permissions` is
    // the interactive equivalent of bypassPermissions.
    return ["claude", "--dangerously-skip-permissions", ...modelArgs];
  }
  return [
    "claude",
    "-p",
    "--verbose",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--permission-mode", permissionMode,
    "--allowedTools", WORQLOAD_PROTOCOL_ALLOW,
    ...modelArgs,
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
  // Subscribe is racey by construction: the handler does `await readEvents`
  // (disk) before sending the replay, and `appendAndBroadcast` can fire
  // `ws.send` for a brand-new event while that await is still pending. With
  // a naive broadcast loop the new event would hit the wire BEFORE the
  // replay events, the client filters `ev.seq <= lastSeq` and silently drops
  // the older replay events. While the subscribe handler is in flight,
  // broadcasts queue here instead of going through `ws.send`; the handler
  // flushes the queue after replay completes (skipping any seq already
  // covered by the replay).
  subscribeState?: "pending" | "live";
  queuedBroadcasts?: import("./event-log").Event[];
}

interface SessionAttachment {
  client: HostClient;
  // PID of the host process (whether we spawned it or reconnected). Used at
  // shutdown when killHosts is requested.
  hostPid?: number;
  // Defined only when this serve instance is the one that spawned the host
  // (and that host runs as a real subprocess).
  hostProc?: Subprocess;
  // The wake watchdog runs at most one timer per attachment. Its deadline is
  // anchored to the FIRST still-unacknowledged wake: a later wake arriving
  // while earlier feedback is still undrained does not push the deadline out
  // (otherwise a human appending feedback faster than the threshold would
  // postpone recovery forever). watchdogArmedAt is the timestamp of that
  // anchoring wake while a watchdog is pending, and undefined once it has
  // fired (acknowledged → quiet, or auto-resumed) so the next wake re-arms a
  // fresh deadline. Attachment replacement leaves the old timer to fire and
  // bail out via the identity check in runWakeWatchdog.
  watchdogTimer?: ReturnType<typeof setTimeout>;
  watchdogArmedAt?: number;
}

// Brings a session's host to life and returns a client for talking to it. The
// production launcher spawns `worqload session-host` as a detached subprocess;
// tests inject an in-process stand-in so the suite doesn't pay one (or two)
// process spawns per session.
export interface HostLaunchRequest {
  meta: SessionMeta;
  sessionsDir: string;
  agentEndpoint: string;
  spawnCommand: string[];
  agentName: AgentName;
  driverName: DriverName;
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
  agentName: AgentName;
  driverName: DriverName;
  spawnCommand: string[];
  spawnCommandForAgent: (agentName: AgentName, model?: string) => string[];
  branchNameGenerator: BranchNameGenerator;
  hostLauncher: HostLauncher;
  worktreeOps: WorktreeOps;
  // Resolves the PR URL tracking a session's branch on the remote. Kept off
  // WorktreeOps so worqload core stays unaware of `gh`; the default
  // (ghPrLinkResolver) is the one place that knows.
  prLinkResolver: PrLinkResolver;
  clients: Map<string, SessionAttachment>;
  // One promise chain per session, serialising host create/teardown. Two
  // resume triggers racing (a manual Resume and the wake watchdog, or two
  // feedback POSTs each finding no client) would otherwise both spawn a host
  // and the later ctx.clients.set would silently overwrite — and orphan — the
  // host the other just started. See withHostSpawnLock.
  hostSpawnLocks: Map<string, Promise<unknown>>;
  baseUrlForAgent: string;
  wsClients: Set<ServerWebSocket<WsClientData>>;
  // Wall-clock of the latest claude_* event observed per session. Used by the
  // wake watchdog only as a liveness signal for a manual wake with an empty
  // inbox; queued-feedback delivery is judged by the inbox itself, not this.
  lastClaudeActivityAt: Map<string, number>;
  // Wall-clock of the latest `worqload feedback fetch` (internal feedback GET)
  // per session. An empty inbox alone is ambiguous — it could mean "the agent
  // drained it" or "nothing was ever queued (a manual wake)". A fetch at/after
  // the wake is the authoritative proof the agent actually picked the feedback
  // up, even when that fetch produced no claude_* event of its own.
  lastFeedbackFetchAt: Map<string, number>;
  // Watchdog threshold. Zero (or negative) disables the watchdog entirely.
  wakeWatchdogMs: number;
  // The agent is expected to close each turn with a Report (or an Escalation,
  // which pauses for the human). When a turn ends with neither, serve sends the
  // agent a message asking it to report so the session never goes silently
  // idle on the human. maxAutoNudges caps consecutive such nudges so an agent
  // that simply never reports can't be re-poked forever; a real Report or
  // Escalation resets the count. Zero disables the nudge entirely.
  maxAutoNudges: number;
  // Per session: whether a Report/Escalation was seen since the current turn
  // began. Set when one is appended, consumed (and reset) at the turn-end
  // `result` event to decide whether that turn earned a nudge.
  reportedThisTurn: Map<string, boolean>;
  // Per session: consecutive auto-nudges sent without an intervening Report or
  // Escalation. Compared against maxAutoNudges; reset to 0 by a real one.
  autoNudgeCount: Map<string, number>;
  // Per-attachment byte cap and per-message attachment count cap, applied to
  // both feedback and report image uploads. Attachments above either limit are
  // rejected with 400 at the POST.
  attachmentMaxBytes: number;
  attachmentMaxCount: number;
  // Path to the YAML config (`~/.config/worqload/config.yaml`) holding the
  // revise-mode settings: the textlint rules and the reviseFeedback override.
  configPath: string;
  // The last successfully loaded revise-mode textlint rules. Seeded at startup
  // and refreshed from configPath on each report submission so config edits
  // take effect without a restart; a parse that fails leaves this value
  // unchanged. Empty when no config exists. Only consulted while a session has
  // revise mode on (see postInternalReports).
  textlintRules: TextlintRule[];
  // The last successfully loaded `reviseFeedback:` guidance, or null when none
  // is configured (the bounce then carries no guidance). Seeded and refreshed
  // alongside textlintRules with the same keep-previous-on-parse-failure
  // behavior.
  reviseFeedbackGuidance: string | null;
  // The morphological tokenizer the lint gate uses for inflected matches, built
  // lazily on the first revise-mode submission (see currentTextlintTokenizer).
  // undefined = not yet built; null = build failed (gate runs literal-only).
  textlintTokenizer?: Tokenizer<IpadicFeatures> | null;
  // Sync command-approval waiters: the POST handler holds the HTTP response
  // open until the escalation is resolved, then returns the result directly.
  // Key: `${sessionId}/${filename}`.
  commandApprovalWaiters: Map<string, { resolve: (result: CommandApprovalSyncResult) => void }>;
}

export interface StartServerOptions {
  port?: number;                // 0 = random
  repoDir?: string;
  spawnCommand?: string[];      // override the agent binary command
  // Which agent CLI worqload spawns per session. "claude" (default), "codex",
  // or "cursor". Picked by the WORQLOAD_AGENT env var in production.
  agentName?: AgentName;
  // Which SessionDriver communication method to use. "pipe" (default) talks
  // to the agent CLI over stdin/stdout; "tmux" drives interactive claude in a
  // tmux session. The effective SessionDriverFactory is resolved from the
  // (agentName, driverName) pair — e.g. codex+pipe uses codexPipeDriver.
  driverName?: DriverName;
  // Overrides the helper that turns a prompt into a short branch name.
  // Return null to skip generation; the caller then falls back to <shortId>.
  branchNameGenerator?: BranchNameGenerator;
  hostCommand?: string[];       // override how the (subprocess) host is launched
  hostLauncher?: HostLauncher;  // override host launch entirely (tests use this)
  worktreeOps?: WorktreeOps;    // override the git/worktree layer (tests use a fake)
  prLinkResolver?: PrLinkResolver; // override the branch→PR-URL resolver (tests use a fake)
  // Auto-resume threshold for the wake watchdog (ms). When it fires, if the
  // feedback inbox still holds an unfetched message (or, with nothing queued,
  // claude has stayed silent since the wake), it tears down the host and
  // re-spawns with --continue so RESUME_KICKOFF forces a fetch. Zero or
  // negative disables it. Production default is 90s; tests override down.
  wakeWatchdogMs?: number;
  // Max consecutive auto-nudges for turns that end without a Report or
  // Escalation. Zero disables the nudge. Production default is below; tests
  // override it to exercise the cap with few turns.
  maxAutoNudges?: number;
  // Per-attachment byte cap and per-message attachment count cap, applied to
  // both feedback and report image uploads. Tests use these to keep size-limit
  // assertions cheap.
  attachmentMaxBytes?: number;
  attachmentMaxCount?: number;
  // Path to the YAML config holding the revise-mode settings (textlint rules
  // and the reviseFeedback override). Defaults to
  // `~/.config/worqload/config.yaml`; tests point it at a temp file to inject
  // settings. A missing file means no rules and the default feedback wording.
  configPath?: string;
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
  timeoutMs?: number;
}

interface CommandApprovalSyncResult {
  decision: "approve" | "reject";
  feedbackContent: string;
  runResult?: ApprovedCommandResult;
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

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
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
  timeoutMs: number;
}

async function runApprovedCommand(command: string, cwd: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<ApprovedCommandResult> {
  const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill("SIGKILL"); } catch {} }, timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return {
    exitCode: typeof exitCode === "number" ? exitCode : null,
    signal: proc.signalCode ?? null,
    stdout: truncateOutput(stdout),
    stderr: truncateOutput(stderr),
    timedOut,
    timeoutMs,
  };
}

function describeCommandExit(result: ApprovedCommandResult): string {
  if (result.timedOut) {
    const seconds = result.timeoutMs / 1000;
    return `killed (timed out after ${seconds}s)`;
  }
  if (result.signal) return `killed by ${result.signal}`;
  return String(result.exitCode ?? "unknown");
}

function fencedBlock(text: string): string {
  return "```\n" + (text === "" ? "(empty)" : text.replace(/\n$/, "")) + "\n```";
}

function formatApprovedCommandFeedback(escalationFilename: string, command: string, agentReason: string, result: ApprovedCommandResult, note: string): string {
  const parts = [
    `Re: command approval ${escalationFilename}`,
    "The human approved this command. worqload ran it in your worktree; here is the result.",
    `## Command\n\n${fencedBlock(command)}`,
  ];
  if (agentReason !== "") parts.push(`## Reason for the request\n\n${agentReason}`);
  if (note !== "") parts.push(`## Human note\n\n${note}`);
  parts.push(
    `## Exit code\n\n${describeCommandExit(result)}`,
    `## stdout\n\n${fencedBlock(result.stdout)}`,
    `## stderr\n\n${fencedBlock(result.stderr)}`,
  );
  return parts.join("\n\n") + "\n";
}

function formatRejectedCommandFeedback(escalationFilename: string, command: string, agentReason: string, note: string): string {
  const parts = [
    `Re: command approval ${escalationFilename}`,
    "The human rejected this command; it was not run.",
    `## Rejected command\n\n${fencedBlock(command)}`,
  ];
  if (agentReason !== "") parts.push(`## Reason for the request\n\n${agentReason}`);
  if (note !== "") parts.push(`## Human note\n\n${note}`);
  return parts.join("\n\n") + "\n";
}

// Relative path (from the worktree root, i.e. the agent's CWD) of the scratch
// file the first submission is saved to for the session to edit in place.
// `.worqload-draft/` is the session-private scratch dir pre-created with the
// worktree and hidden from the explorer / dirty-check / auto-commit.
const REVISION_DRAFT_RELPATH = ".worqload-draft/revision-draft.md";

// Delivered into the feedback inbox when revise mode holds a report's first
// submission. The bounce can't rely on the `worqload report submit` stdout
// alone: a session that just submitted a report has, from its own point of
// view, finished and likely ended its turn — so it routes through the inbox,
// which wakes the session and is drained exactly once. The first submission is
// saved to a scratch file the session edits in place, rather than re-typed from
// this message, so nothing is dropped in the round trip. The scaffold (status
// line, draft path, resubmit command) is the fixed template; the editorial
// guidance is supplied entirely by the human via `reviseFeedback:` in the
// config and is absent otherwise. The scaffold sentence ends before the
// `{{guidance}}` slot, so the configured guidance follows as natural prose: it
// is appended as a space-separated continuation when present, and the slot
// collapses to nothing when no guidance is configured.
function buildRevisionRequestFeedback(slug: string, guidance?: string): string {
  const guidanceText = guidance?.trim();
  return revisionRequestScaffold
    .replaceAll("{{guidance}}", guidanceText ? ` ${guidanceText}` : "")
    .replaceAll("{{draftPath}}", REVISION_DRAFT_RELPATH)
    .replaceAll("{{slug}}", slug);
}

// Delivered when a report submitted under revise mode trips the textlint rules.
// Lists each forbidden string with its configured comment, then explains the
// `\` escape so the session can legitimately keep a flagged word — e.g. when it
// must quote the word itself — by prefixing a backslash; the backslash exempts
// that one occurrence and is left in the stored report. Routes through the same
// scratch-draft + resubmit loop as buildRevisionRequestFeedback.
function buildTextlintBounceFeedback(slug: string, violations: TextlintViolation[]): string {
  const findings = violations.map(v => `- \`${v.string}\`: ${v.comment}`).join("\n");
  const escapeExample = violations[0]?.string ?? "";
  return [
    "A report you submitted was held: it tripped this session's textlint rules and was not stored.",
    `Your draft was saved to \`${REVISION_DRAFT_RELPATH}\`. Remove or rephrase the following in that file:`,
    findings,
    `To keep a flagged word on purpose — for instance when quoting it — prefix it with a backslash (\`\\${escapeExample}\`). The backslash exempts that occurrence from the lint and stays in the stored report.`,
    `Then resubmit the corrected draft: \`worqload report submit --slug ${slug} < ${REVISION_DRAFT_RELPATH}\`.`,
  ].join("\n\n") + "\n";
}

// Holds a report submission instead of storing it: saves the body to the
// session's scratch draft so it can edit in place, queues `feedbackContent`
// into the inbox, and wakes the session to revise and resubmit. Bouncing
// through the feedback inbox (not the CLI stdout alone) is what wakes the
// session: one that just submitted a report has, from its own point of view,
// finished and likely ended its turn. Shared by the generic revise-mode bounce
// and the textlint bounce.
async function bounceReportForRevision(
  ctx: ServerContext,
  meta: SessionMeta,
  body: NumberedBody,
  feedbackContent: string,
  reason: string,
): Promise<Response> {
  await Bun.write(join(meta.worktreePath, REVISION_DRAFT_RELPATH), body.content);
  const inbox = feedbackInboxDirFor(ctx, meta.id);
  const file = await writeNumberedFile(inbox, "revision-requested", feedbackContent, {
    archiveDirs: [feedbackReadDirFor(ctx, meta.id)],
  });
  await appendAndBroadcast(ctx, meta.id, { kind: "feedback_received", payload: { filename: file.filename } });
  const att = ctx.clients.get(meta.id);
  appendHostLog(ctx, meta.id, "wake_sent", {
    filename: file.filename,
    seq: file.seq,
    hasClient: att !== undefined,
    status: meta.status,
    reason,
  });
  if (att) {
    att.client.send("[wake] check feedback inbox").catch(() => {});
    scheduleWakeWatchdog(ctx, meta.id, att);
  } else if (!isTerminal(meta.status)) {
    await respawnMissingClient(ctx, meta, reason);
  }
  return json({ revisionRequested: true });
}

// Re-reads the textlint config so edits take effect without a server restart.
// Reports are human-paced, so re-reading the small YAML per submission is cheap,
// and reading here rather than via a file watcher sidesteps the atomic-rename
// gotcha that makes single-file watches stop firing after an editor saves. A
// config that fails to parse keeps the last good rules and is logged, so a typo
// mid-edit can't wedge report submission.
async function currentTextlintRules(ctx: ServerContext): Promise<TextlintRule[]> {
  try {
    ctx.textlintRules = await loadTextlintRules(ctx.configPath);
  } catch (err) {
    console.error(`[textlint] config reload failed, keeping previous rules: ${err instanceof Error ? err.message : String(err)}`);
  }
  return ctx.textlintRules;
}

// Resolves the morphological tokenizer the lint gate uses for inflected matches,
// building it once on first use (memoized in textlint and cached on ctx) rather
// than at startup, so servers that never enter revise mode never pay the
// dictionary load. A build failure is logged once and degrades the gate to
// literal-only matching instead of blocking submission.
async function currentTextlintTokenizer(ctx: ServerContext): Promise<Tokenizer<IpadicFeatures> | undefined> {
  if (ctx.textlintTokenizer === undefined) {
    try {
      ctx.textlintTokenizer = await getTextlintTokenizer();
    } catch (err) {
      ctx.textlintTokenizer = null;
      console.error(`[textlint] tokenizer build failed, using literal matching only: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return ctx.textlintTokenizer ?? undefined;
}

// The current `reviseFeedback:` guidance, reloaded from the same config on each
// submission so wording edits take effect without a restart. A parse failure
// keeps the previous value, matching currentTextlintRules. Null means the
// bounce carries no guidance.
async function currentReviseFeedbackGuidance(ctx: ServerContext): Promise<string | null> {
  try {
    ctx.reviseFeedbackGuidance = await loadReviseFeedbackGuidance(ctx.configPath);
  } catch (err) {
    console.error(`[reviseFeedback] config reload failed, keeping previous guidance: ${err instanceof Error ? err.message : String(err)}`);
  }
  return ctx.reviseFeedbackGuidance;
}

async function currentSkillButtons(ctx: ServerContext): Promise<SkillButton[]> {
  try {
    return await loadSkillButtons(ctx.configPath);
  } catch (err) {
    console.error(`[skillButtons] config reload failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

interface SkillActionDescriptor {
  id: string;
  label: string;
  description?: string;
  direct: true;
  group: string;
  feedbackContent: string;
}

function skillButtonToDescriptor(skill: SkillButton): SkillActionDescriptor {
  return {
    id: `skill:${skill.name}`,
    label: skill.name,
    description: skill.description,
    direct: true,
    group: "skill",
    feedbackContent: `/${skill.name}`,
  };
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
  trackAutoNudge(ctx, sessionId, event);
  const payload = JSON.stringify({ sessionId, event });
  for (const ws of ctx.wsClients) {
    if (ws.data.sessionId !== sessionId) continue;
    if (ws.data.subscribeState === "pending") {
      // Queue rather than send — the subscribe handler is mid-await and a
      // direct send here would arrive before its replay events, causing the
      // client's seq filter to discard the (older) replay.
      ws.data.queuedBroadcasts?.push(event);
    } else {
      try { ws.send(payload); } catch { /* dead socket */ }
    }
  }
}

// Keeps the per-session "did this turn report?" flag and the consecutive-nudge
// count current as events flow through broadcastEvent, and on a turn-end that
// carried neither a Report nor an Escalation, sends the agent a message asking
// it to report — capped at maxAutoNudges so an agent that never reports isn't
// re-poked forever. Both Report/Escalation events (server-appended) and the
// claude turn-end event pass this same chokepoint, so their relative order is
// preserved: the agent's `worqload report submit` completes (appending
// report_submitted) before claude emits the turn's result line.
function trackAutoNudge(ctx: ServerContext, sessionId: string, event: Event): void {
  if (ctx.maxAutoNudges <= 0) return;
  if (event.kind === "report_submitted" || event.kind === "escalation_requested") {
    ctx.reportedThisTurn.set(sessionId, true);
    ctx.autoNudgeCount.set(sessionId, 0);
    return;
  }
  if (event.kind !== "turn_completed") return;
  const reported = ctx.reportedThisTurn.get(sessionId) ?? false;
  ctx.reportedThisTurn.set(sessionId, false);
  if (reported) return;
  const sent = ctx.autoNudgeCount.get(sessionId) ?? 0;
  if (sent >= ctx.maxAutoNudges) {
    appendHostLog(ctx, sessionId, "auto_nudge_capped", { sent });
    return;
  }
  // No live attachment means the host socket is gone; there is nothing to
  // write to. The missing-client feedback path (respawnMissingClient) covers
  // recovery there — this nudge is best-effort like a manual wake.
  const att = ctx.clients.get(sessionId);
  if (!att) return;
  att.client.send(TURN_WITHOUT_REPORT_NUDGE).catch(() => {});
  ctx.autoNudgeCount.set(sessionId, sent + 1);
  appendHostLog(ctx, sessionId, "auto_nudge_sent", { sent: sent + 1 });
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
// event and sends the agent its first message.
function makeSpawnHostLauncher(config: { hostCommand: string[] }): HostLauncher {
  return async ({ meta, sessionsDir, agentEndpoint, spawnCommand, agentName, driverName, resume, onEvent, onDisconnect }) => {
    const socketPath = hostSocketPathFor(meta.id);
    const logFile = hostLogPath(sessionsDir, meta.id);
    // The hello handshake asks the host to replay events with seq > sinceSeq.
    // serve already has every event currently in the file, so reading the
    // current tail and passing it as sinceSeq keeps the replay empty in the
    // common case. Resume without this would re-broadcast the entire history
    // back through onEvent on every spawn — once over the WS to every viewing
    // client, and once into lastClaudeActivityAt, which the wake watchdog reads
    // for liveness.
    const lastSeq = (await readEvents(meta.id, 1, sessionsDir)).at(-1)?.seq ?? 0;
    const hostProc = spawnDetachedHost({
      sessionId: meta.id,
      sessionsDir,
      socketPath,
      agentEndpoint,
      spawnCommand,
      hostCommand: config.hostCommand,
      logFile,
      ...(agentName !== "claude" ? { agentName } : {}),
      ...(driverName !== "pipe" ? { driverName } : {}),
      ...(resume && { resume: true }),
    });
    const client = await connectToHost({ socketPath, sinceSeq: lastSeq, onEvent, onDisconnect });
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

// How many turns in a row that end without a Report or Escalation serve will
// nudge before giving up. One nudge catches the agent that simply forgot; a
// second covers the agent that ignored the first. Beyond that the agent is
// demonstrably not going to report, and re-poking only burns tokens, so we
// fall silent and leave the session for the human.
const DEFAULT_MAX_AUTO_NUDGES = 2;

// One pending watchdog per attachment, anchored to the first wake that has
// not yet been acknowledged. A wake arriving while one is already pending does
// NOT re-arm it: streamed feedback (a human appending every second) would
// otherwise reset the deadline indefinitely and the inbox would rot
// undelivered. Once the pending watchdog fires (runWakeWatchdog clears
// watchdogArmedAt either way), the next wake arms a fresh deadline. An
// attachment replacement leaves the prior timer pending, but runWakeWatchdog's
// identity check makes it a no-op.
function scheduleWakeWatchdog(ctx: ServerContext, sessionId: string, att: SessionAttachment): void {
  if (ctx.wakeWatchdogMs <= 0) return;
  if (att.watchdogArmedAt !== undefined) return;
  const wakeAt = Date.now();
  att.watchdogArmedAt = wakeAt;
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
  // The timer is spent. Release the anchor so the next wake re-arms a fresh
  // deadline, whatever this run decides below (stay quiet, or auto-resume).
  // On a stale fire this only touches the now-discarded attachment.
  expectedAtt.watchdogArmedAt = undefined;
  const meta = await loadSessionMeta(sessionId, ctx.sessionsDir);
  if (!meta || isTerminal(meta.status)) return; // session has moved on
  // Identity check: the attachment that received the wake must still be the
  // current one. If the user manually resumed (or a previous watchdog already
  // respawned), ctx.clients now holds a different attachment and this fire is
  // stale.
  const currentAtt = ctx.clients.get(sessionId);
  if (currentAtt !== expectedAtt) return;

  // The inbox is the authoritative "was the feedback picked up" signal:
  // `worqload feedback fetch` moves inbox→read atomically as part of the
  // fetch, so anything still in inbox proves the agent never drained it —
  // no matter how many unrelated claude_* events it emitted meanwhile (a
  // mid-turn claude keeps emitting, ending with a `turn_duration` system
  // event, which would otherwise mask an undelivered wake). Claude activity
  // is only a meaningful liveness signal for a manual wake with nothing
  // queued; for queued feedback the queued file is what matters.
  const inboxRemaining = await listAllFiles(feedbackInboxDirFor(ctx, sessionId));
  const lastActivity = ctx.lastClaudeActivityAt.get(sessionId) ?? 0;
  const lastFeedbackFetch = ctx.lastFeedbackFetchAt.get(sessionId) ?? 0;
  // Quiet only when nothing is queued AND the agent is demonstrably engaged
  // since the wake: it fetched its inbox (the authoritative delivery signal,
  // true even if that fetch emitted no claude_* event) or — for a manual wake
  // with nothing queued — claude produced some event.
  if (inboxRemaining.length === 0 && (lastFeedbackFetch >= wakeAt || lastActivity >= wakeAt)) return;

  const reason = inboxRemaining.length > 0 ? "feedback_unfetched" : "wake_unanswered";
  const silenceMs = Date.now() - wakeAt;
  appendHostLog(ctx, sessionId, "watchdog_auto_resume", { reason, silenceMs, hostPid: expectedAtt.hostPid });
  await appendAndBroadcast(ctx, sessionId, {
    kind: "session_auto_resumed",
    payload: { reason, silenceMs },
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

// Respawn the host for a session that says "running" but has no attached
// client. The wake watchdog handles the "client present but claude is silent"
// case; this handles its peer — "wake fired but ctx.clients is empty," which
// otherwise would silently swallow the wake. Best-effort kill of any leftover
// host PID, then `resume: true` so the new host's RESUME_KICKOFF makes the
// agent fetch whatever the caller just queued into the inbox.
async function respawnMissingClient(
  ctx: ServerContext,
  meta: SessionMeta,
  reason: string,
): Promise<void> {
  appendHostLog(ctx, meta.id, "auto_resume_missing_client", {
    hostPid: meta.hostPid,
    reason,
    status: meta.status,
  });
  await appendAndBroadcast(ctx, meta.id, {
    kind: "session_auto_resumed",
    payload: { reason },
  });
  if (meta.hostPid !== undefined) {
    // Fire-and-forget: if the PID is dead, kill returns ESRCH and we ignore it.
    try { process.kill(meta.hostPid, "SIGTERM"); } catch {}
  }
  const { endedAt: _endedAt, archivedAt: _archivedAt, ...rest } = meta;
  const resumed: SessionMeta = { ...rest, status: "running" };
  await saveSessionMeta(resumed, ctx.sessionsDir);
  try {
    await spawnAndAttachHost(ctx, resumed, { resume: true });
  } catch (err) {
    appendHostLog(ctx, meta.id, "auto_resume_failed", { error: String(err) });
  }
}

// Serialises host create/teardown per session. Every host spawn funnels
// through spawnAndAttachHost; chaining each call onto a per-session promise
// means a second resume trigger cannot begin its spawn until the first has
// finished attaching — so it observes the first's attachment and tears it
// down (terminateTrackedHost) instead of silently overwriting it. The chain's
// stored tail swallows results so one failed spawn does not reject every
// spawn queued behind it.
function withHostSpawnLock<T>(
  ctx: ServerContext,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = ctx.hostSpawnLocks.get(sessionId) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  ctx.hostSpawnLocks.set(sessionId, run.then(() => {}, () => {}));
  return run;
}

// Tears down the host currently attached to a session, if any, before a
// replacement is spawned. The kill goes over the socket so the host forwards
// SIGTERM to its claude child and reaps it; signalling the host PID directly
// would leave claude orphaned (reparented to launchd, still holding the
// conversation). Must run inside withHostSpawnLock so the attachment it reads
// cannot change underneath it.
async function terminateTrackedHost(ctx: ServerContext, sessionId: string): Promise<void> {
  const att = ctx.clients.get(sessionId);
  if (!att) return;
  try {
    await att.client.kill("SIGTERM");
    await Promise.race([att.client.exited, new Promise((r) => setTimeout(r, 2000))]);
  } catch {
    // host already gone — nothing to wait for
  }
  if (ctx.clients.get(sessionId) === att) ctx.clients.delete(sessionId);
}

async function spawnAndAttachHost(
  ctx: ServerContext,
  meta: SessionMeta,
  opts: { resume?: boolean } = {},
): Promise<HostClient> {
  return withHostSpawnLock(ctx, meta.id, async () => {
    // A host may already be attached — a racing resume trigger reached here
    // first. Tear it down before the new one replaces it in ctx.clients,
    // otherwise the old host (and its claude child) leaks untracked.
    await terminateTrackedHost(ctx, meta.id);
    await writeAgentEndpointFile(ctx, meta.id);
    // Forward-declared so onDisconnect can identity-check before evicting: a
    // stopped host's socket tears down a beat after its replacement attaches
    // (the Stop&Resume race), and its stale onDisconnect must not delete the
    // newer attachment. Same guard runWakeWatchdog already uses.
    let attachment: SessionAttachment | undefined;
    const agentName = meta.agentName ?? ctx.agentName;
    const driverName = meta.driverName ?? ctx.driverName;
    const spawnCommand = ctx.spawnCommandForAgent(agentName, meta.model);
    const effectiveSpawnCommand = opts.resume && agentName === "claude"
      ? [...spawnCommand, "--continue"]
      : spawnCommand;
    const { client, hostProc } = await ctx.hostLauncher({
      meta,
      sessionsDir: ctx.sessionsDir,
      agentEndpoint: ctx.baseUrlForAgent,
      spawnCommand: effectiveSpawnCommand,
      agentName,
      driverName,
      resume: opts.resume ?? false,
      onEvent: (event) => broadcastEvent(ctx, meta.id, event),
      onDisconnect: () => {
        if (attachment && ctx.clients.get(meta.id) === attachment) {
          ctx.clients.delete(meta.id);
        }
      },
    });
    attachment = { client, hostProc, hostPid: hostProc?.pid };
    ctx.clients.set(meta.id, attachment);
    return client;
  });
}

// Reconnect to an already-running host after the serve process restarted.
// Returns null if the socket isn't reachable (host has died).
async function reconnectToHost(ctx: ServerContext, meta: SessionMeta): Promise<HostClient | null> {
  if (!meta.hostSocketPath) return null;
  try {
    await writeAgentEndpointFile(ctx, meta.id);
    const lastSeq = (await readEvents(meta.id, 1, ctx.sessionsDir)).at(-1)?.seq ?? 0;
    let attachment: SessionAttachment | undefined;
    const client = await connectToHost({
      socketPath: meta.hostSocketPath,
      sinceSeq: lastSeq,
      connectTimeoutMs: 500,
      onEvent: (event) => broadcastEvent(ctx, meta.id, event),
      onDisconnect: () => {
        if (attachment && ctx.clients.get(meta.id) === attachment) {
          ctx.clients.delete(meta.id);
        }
      },
    });
    await client.replayCompleted.catch(() => {});
    attachment = { client, hostPid: meta.hostPid };
    ctx.clients.set(meta.id, attachment);
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
  const agentName: AgentName = opts.agentName ?? "claude";
  const driverName = opts.driverName ?? "pipe";
  const spawnCommand = opts.spawnCommand ?? buildDefaultSpawnCommand(agentName, driverName);
  const overriddenSpawnCommand = opts.spawnCommand;
  const spawnCommandForAgent: (name: AgentName, model?: string) => string[] = overriddenSpawnCommand !== undefined
    ? () => overriddenSpawnCommand
    : (name, model) => buildDefaultSpawnCommand(name, driverName, model);
  const branchNameGenerator = opts.branchNameGenerator ?? defaultBranchNameGenerator;
  const hostCommand = opts.hostCommand ?? buildDefaultHostCommand();
  const hostLauncher = opts.hostLauncher ?? makeSpawnHostLauncher({ hostCommand });
  const overriddenReportRewriter = opts.reportRewriter;
  const reportRewriterForAgent: (name: AgentName) => ReportRewriter = overriddenReportRewriter !== undefined
    ? () => overriddenReportRewriter
    : (name) => name === "codex"
      ? makeCodexReportRewriter({ spawnCommand: spawnCommandForAgent(name) })
      : name === "cursor"
        ? makeCursorReportRewriter({ spawnCommand: spawnCommandForAgent(name) })
        : makeClaudeReportRewriter({ spawnCommand: spawnCommandForAgent(name) });
  const reportRewriter = reportRewriterForAgent(agentName);
  const worktreeOps = opts.worktreeOps ?? realWorktreeOps;
  // Cache wraps whatever resolver is in play (the gh one in production, a fake
  // in tests) so the sidebar's background prefetch doesn't respawn `gh` per
  // session per poll and an opened session shows its link without a beat.
  const prLinkResolver = makeCachedPrLinkResolver(opts.prLinkResolver ?? ghPrLinkResolver);

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
        // Until the client sends `subscribe`, queue any broadcasts that arrive
        // for this session — broadcasts arriving before subscribe completes
        // would otherwise out-pace the replay and be dropped by the client's
        // seq filter. See WsClientData.subscribeState.
        ws.data.subscribeState = "pending";
        ws.data.queuedBroadcasts = [];
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
            // Flush broadcasts that landed during the await above. The replay
            // already covers everything on disk at read time, so anything in
            // the queue with seq <= replayLastSeq is a duplicate (the
            // broadcast and the disk-read raced over the same event).
            const replayLastSeq = events.length > 0 ? events[events.length - 1].seq : (msg.lastSeq ?? 0);
            const queued = ws.data.queuedBroadcasts ?? [];
            ws.data.queuedBroadcasts = undefined;
            ws.data.subscribeState = "live";
            for (const ev of queued) {
              if (ev.seq <= replayLastSeq) continue;
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

  const configPath = opts.configPath ?? defaultConfigPath();
  const textlintRules = await loadTextlintRules(configPath);
  const reviseFeedbackGuidance = await loadReviseFeedbackGuidance(configPath);

  ctx = {
    repoDir,
    worqloadDir,
    sessionsDir,
    worktreesDir,
    agentName,
    driverName,
    spawnCommand,
    spawnCommandForAgent,
    branchNameGenerator,
    hostLauncher,
    worktreeOps,
    prLinkResolver,
    clients: new Map(),
    hostSpawnLocks: new Map(),
    port: server.port,
    baseUrlForAgent: `http://127.0.0.1:${server.port}`,
    wsClients: new Set(),
    lastClaudeActivityAt: new Map(),
    lastFeedbackFetchAt: new Map(),
    wakeWatchdogMs: opts.wakeWatchdogMs ?? DEFAULT_WAKE_WATCHDOG_MS,
    maxAutoNudges: opts.maxAutoNudges ?? DEFAULT_MAX_AUTO_NUDGES,
    reportedThisTurn: new Map(),
    autoNudgeCount: new Map(),
    attachmentMaxBytes: opts.attachmentMaxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES,
    attachmentMaxCount: opts.attachmentMaxCount ?? DEFAULT_ATTACHMENT_MAX_COUNT,
    configPath,
    textlintRules,
    reviseFeedbackGuidance,
    commandApprovalWaiters: new Map(),
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
  defineRoute("POST", "/sessions/archived/prune", postPruneArchived),
  defineRoute("DELETE", "/sessions/:id", deleteSession),
  defineRoute("POST", "/sessions/:id/title", postTitle),
  defineRoute("POST", "/sessions/:id/model", postModel),
  defineRoute("POST", "/sessions/:id/revise-mode", postReviseMode),
  defineRoute("POST", "/sessions/:id/feedback/batch", postFeedbackBatch),
  defineRoute("POST", "/sessions/:id/feedback", postFeedback),
  defineRoute("GET",  "/sessions/:id/feedback", getFeedbackHistory),
  defineRoute("GET",  "/sessions/:id/feedback/:filename/attachments/:name", getFeedbackAttachment),
  defineRoute("DELETE", "/sessions/:id/feedback/:filename", deleteFeedback),
  defineRoute("POST", "/sessions/:id/escalations/:filename/resolve", postEscalationResolve),
  defineRoute("GET",  "/sessions/:id/reports", getReports),
  defineRoute("GET",  "/sessions/:id/reports/:filename/attachments/:name", getReportAttachment),
  defineRoute("POST", "/sessions/:id/reports/read-all", postReportsReadAll),
  defineRoute("POST", "/sessions/:id/reports/:filename/read", postReportRead),
  defineRoute("POST", "/sessions/:id/reports/:filename/unread", postReportUnread),
  defineRoute("DELETE", "/sessions/:id/reports/:filename", deleteReport),
  defineRoute("GET",  "/sessions/:id/asking", getAsking),
  defineRoute("GET",  "/sessions/:id/diff", getDiff),
  defineRoute("GET",  "/sessions/:id/files", getFiles),
  defineRoute("GET",  "/sessions/:id/structure", getStructure),
  defineRoute("GET",  "/sessions/:id/call-graph", getCallGraph),
  defineRoute("GET",  "/sessions/:id/file", getFile),
  defineRoute("GET",  "/sessions/:id/file/raw", getFileRaw),
  defineRoute("PUT",  "/sessions/:id/file", putFile),
  defineRoute("POST", "/sessions/:id/file", postFile),
  defineRoute("DELETE", "/sessions/:id/file", deleteFile),
  defineRoute("POST", "/sessions/:id/file/rename", postFileRename),
  defineRoute("GET",  "/sessions/:id/search", getFileSearch),
  defineRoute("GET",  "/sessions/:id/code-nav/definition", getCodeNavDefinition),
  defineRoute("GET",  "/sessions/:id/code-nav/references", getCodeNavReferences),
  defineRoute("GET",  "/sessions/:id/permalink", getPermalink),
  defineRoute("GET",  "/sessions/:id/pr-link", getPrLink),
  defineRoute("GET",  "/actions", getActions),
  defineRoute("GET",  "/sessions/:id/actions", getSessionActions),
  defineRoute("POST", "/sessions/:id/actions/:actionId", postSessionAction),
  defineRoute("POST", "/internal/sessions/:id/reports", postInternalReports),
  defineRoute("POST", "/internal/sessions/:id/escalations", postInternalEscalations),
  defineRoute("POST", "/internal/sessions/:id/command-approvals", postInternalCommandApprovals),
  defineRoute("GET",  "/internal/sessions/:id/feedback", getInternalFeedback),
  defineRoute("GET",  "/internal/sessions/:id/feedback/history", getInternalFeedbackHistory),
  defineRoute("GET",  "/internal/sessions/:id/feedback/by-filename/:filename", getInternalFeedbackByFilename),
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
  return json({ repoDir: ctx.repoDir, repoName: basename(ctx.repoDir), driverName: ctx.driverName });
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
  agentName?: AgentName;
  model?: string;
  startPaused?: boolean;
}

function isAgentName(value: unknown): value is AgentName {
  return value === "claude" || value === "codex" || value === "cursor";
}

async function postSessions(req: Request, ctx: ServerContext): Promise<Response> {
  const body = (await req.json()) as PostSessionsBody;
  if (!body || typeof body.prompt !== "string" || body.prompt.trim() === "") {
    return json({ error: "prompt is required" }, 400);
  }
  if (body.agentName !== undefined && !isAgentName(body.agentName)) {
    return json({ error: "agentName must be 'claude', 'codex', or 'cursor'" }, 400);
  }

  const agentName = body.agentName ?? ctx.agentName;
  const model = agentName === "claude" ? body.model : undefined;
  const baseBranch = body.baseBranch?.trim() || (await ctx.worktreeOps.currentBranch(ctx.repoDir));
  const baseCommit = await ctx.worktreeOps.resolveBaseCommit(baseBranch, ctx.repoDir);

  // worktreePath and branchName are populated after the id is assigned below
  // (we need the id to compute the worktree dir and the shortId fallback).
  const startPaused = body.startPaused === true;
  const tentative = createSession({
    prompt: body.prompt,
    baseBranch,
    baseCommit,
    worktreePath: "",
    branchName: "",
    agentName,
    model,
    title: body.title,
    startPaused,
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
  if (!startPaused) {
    await spawnAndAttachHost(ctx, meta);
  }

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
    const [reports, readSet, events, asking] = await Promise.all([
      listAllFiles(dir),
      readReadState(dir),
      readEvents(meta.id, 1, ctx.sessionsDir),
      listAllFiles(askingDirFor(ctx, meta.id)),
    ]);
    const unreadReportCount = reports.reduce((n, r) => n + (readSet.has(r.filename) ? 0 : 1), 0);
    const unresolvedEscalationCount = asking.length;
    // The sidebar's liveness signal: when the agent last did something — its run
    // or a step within it, not a report/feedback/escalation. Undefined until the
    // session has produced one.
    const agentEvents = events.filter(isAgentWorkEvent);
    const lastAgentEventAt = agentEvents.at(-1)?.timestamp;
    const agentEventCount = agentEvents.length;
    return { ...meta, unreadReportCount, unresolvedEscalationCount, lastAgentEventAt, agentEventCount };
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
    await purgeSession(ctx, meta);
    return json({ ok: true });
  });
}

// The destructive half of deleteSession, factored out so the bulk prune can
// reuse it: removes the worktree, the working branch, and the whole
// .worqload/sessions/<id>/ directory. Caller is responsible for the
// archived-state guard.
async function purgeSession(ctx: ServerContext, meta: SessionMeta): Promise<void> {
  ctx.clients.delete(meta.id);
  ctx.lastClaudeActivityAt.delete(meta.id);
  ctx.lastFeedbackFetchAt.delete(meta.id);
  ctx.reportedThisTurn.delete(meta.id);
  ctx.autoNudgeCount.delete(meta.id);
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
}

interface PruneArchivedBody {
  days?: unknown;
}

// Bulk hard-delete: removes every archived session whose archivedAt predates
// `days` days ago. Same irreversible cleanup as DELETE /sessions/:id, applied
// per match. Deletes run sequentially — each removes a git worktree from the
// shared repo, and parallel removals risk index-lock contention.
async function postPruneArchived(req: Request, ctx: ServerContext): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as PruneArchivedBody;
  if (typeof body.days !== "number" || !Number.isFinite(body.days) || body.days < 0) {
    return json({ error: "days must be a non-negative number" }, 400);
  }
  const cutoff = Date.now() - body.days * 86_400_000;
  const sessions = await listSessionMetas(ctx.sessionsDir);
  const stale = sessions.filter(
    s => s.archivedAt !== undefined && new Date(s.archivedAt).getTime() < cutoff,
  );
  const deleted: string[] = [];
  for (const meta of stale) {
    await purgeSession(ctx, meta);
    deleted.push(meta.id);
  }
  return json({ deleted, count: deleted.length });
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

interface ReviseModeBody {
  enabled?: unknown;
}

// The UI toggle for revise mode. Stored on meta so it rides along in every
// session listing/detail response without extra decoration (isReviseModeEnabled
// reads it; absent means off). Toggling either way clears any pending revision
// so the next submission starts a fresh first-submit/resubmit cycle.
async function postReviseMode(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const body = (await req.json().catch(() => ({}))) as ReviseModeBody;
    if (typeof body.enabled !== "boolean") {
      return json({ error: "enabled must be a boolean" }, 400);
    }
    const { revisionPending: _reset, ...rest } = meta;
    const updated: SessionMeta = { ...rest, reviseModeEnabled: body.enabled };
    await saveSessionMeta(updated, ctx.sessionsDir);
    return json({ meta: updated });
  });
}

interface ModelBody {
  model?: unknown;
}

async function postModel(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const body = (await req.json().catch(() => ({}))) as ModelBody;
    if (typeof body.model !== "string" || body.model.trim() === "") {
      return json({ error: "model must be a non-empty string" }, 400);
    }
    const agentName = meta.agentName ?? ctx.agentName;
    if (agentName !== "claude") {
      return json({ error: "model switching is only supported for claude sessions" }, 400);
    }
    const newModel = body.model.trim();
    if (newModel === meta.model) {
      return json({ meta });
    }

    if (!isTerminal(meta.status)) {
      const att = ctx.clients.get(meta.id);
      if (att) {
        await att.client.kill("SIGTERM");
        await Promise.race([att.client.exited, new Promise((r) => setTimeout(r, 500))]);
        if (ctx.clients.has(meta.id)) {
          await att.client.kill("SIGKILL");
          await att.client.exited.catch(() => {});
        }
      }
      ctx.clients.delete(meta.id);
      await transitionStatus(ctx, meta, "stopped");
      await appendAndBroadcast(ctx, meta.id, { kind: "session_stopped", payload: { reason: "model_switch" } });
    }

    const events = await readEvents(meta.id, 1, ctx.sessionsDir);
    const hasBeenStarted = events.some(e => e.kind === "session_started");

    const stopped = await loadSessionMeta(meta.id, ctx.sessionsDir);
    const { endedAt: _endedAt, archivedAt: _archivedAt, ...rest } = stopped ?? meta;
    const resumed: SessionMeta = { ...rest, model: newModel, status: "running" };
    await saveSessionMeta(resumed, ctx.sessionsDir);
    await spawnAndAttachHost(ctx, resumed, { resume: hasBeenStarted });

    const stored = await loadSessionMeta(meta.id, ctx.sessionsDir);
    return json({ meta: stored ?? resumed });
  });
}

async function getFeedbackHistory(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const inbox = await listAllFiles(feedbackInboxDirFor(ctx, meta.id));
    const read = await listAllFiles(feedbackReadDirFor(ctx, meta.id));
    const all = [
      ...inbox.map(f => ({ filename: f.filename, content: f.content, status: "unread" as const, anchor: f.meta?.anchor, attachments: f.attachments })),
      ...read.map(f => ({ filename: f.filename, content: f.content, status: "read" as const, anchor: f.meta?.anchor, attachments: f.attachments })),
    ];
    all.sort((a, b) => b.filename.localeCompare(a.filename));
    return json({ messages: all });
  });
}

// Whether `name` is a single safe filename (no path separators, no `..`, no
// hidden-prefix). Used to gate the attachment GET against arbitrary disk reads.
function isSafeAttachmentName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (name.startsWith(".")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return true;
}

const ATTACHMENT_CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function attachmentContentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = name.slice(dot + 1).toLowerCase();
  return ATTACHMENT_CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

async function getFeedbackAttachment(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const filename = decodeURIComponent(params.filename);
    const name = decodeURIComponent(params.name);
    if (!isSafeAttachmentName(filename) || !filename.endsWith(".md")) {
      return json({ error: "invalid feedback filename" }, 400);
    }
    if (!isSafeAttachmentName(name)) {
      return json({ error: "invalid attachment name" }, 400);
    }
    const dirName = attachmentsDirNameFor(filename);
    for (const base of [feedbackInboxDirFor(ctx, meta.id), feedbackReadDirFor(ctx, meta.id)]) {
      const path = join(base, dirName, name);
      const file = Bun.file(path);
      if (await file.exists()) {
        return new Response(file, { headers: { "content-type": attachmentContentTypeFor(name) } });
      }
    }
    return json({ error: "attachment not found" }, 404);
  });
}

async function deleteFeedback(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const filename = decodeURIComponent(params.filename);
    if (!isSafeAttachmentName(filename) || !filename.endsWith(".md")) {
      return json({ error: "invalid feedback filename" }, 400);
    }
    const inbox = feedbackInboxDirFor(ctx, meta.id);
    const read = feedbackReadDirFor(ctx, meta.id);
    const inInbox = await Bun.file(join(inbox, filename)).exists();
    const inRead = !inInbox && await Bun.file(join(read, filename)).exists();
    if (!inInbox && !inRead) return json({ error: "feedback not found" }, 404);
    await deleteNumberedFile(inInbox ? inbox : read, filename);
    await appendAndBroadcast(ctx, meta.id, { kind: "feedback_deleted", payload: { filename } });
    return json({ ok: true, filename });
  });
}

// Serves an image attached to a report (`worqload report submit --image`).
// Mirrors getFeedbackAttachment; reports have only the one directory, never an
// inbox/read split, so there is a single place to look.
async function getReportAttachment(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const filename = decodeURIComponent(params.filename);
    const name = decodeURIComponent(params.name);
    if (!isSafeAttachmentName(filename) || !filename.endsWith(".md")) {
      return json({ error: "invalid report filename" }, 400);
    }
    if (!isSafeAttachmentName(name)) {
      return json({ error: "invalid attachment name" }, 400);
    }
    const path = join(reportsDirFor(ctx, meta.id), attachmentsDirNameFor(filename), name);
    const file = Bun.file(path);
    if (await file.exists()) {
      return new Response(file, { headers: { "content-type": attachmentContentTypeFor(name) } });
    }
    return json({ error: "attachment not found" }, 404);
  });
}

async function getSessionDetail(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const events = await readEvents(meta.id, 1, ctx.sessionsDir);
    return json({ meta, events, agentName: ctx.agentName });
  });
}

async function getReports(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const dir = reportsDirFor(ctx, meta.id);
    const [reports, readSet, events] = await Promise.all([
      listAllFiles(dir),
      readReadState(dir),
      readEvents(meta.id, 1, ctx.sessionsDir),
    ]);
    // The report_submitted event is when the report reached the human — the
    // canonical submission time, recorded for existing reports too (the file's
    // own mtime would drift if the sessions tree were ever copied).
    const submittedAt = new Map<string, string>();
    for (const ev of events) {
      if (ev.kind === "report_submitted") {
        const filename = (ev.payload as { filename?: string }).filename;
        if (filename) submittedAt.set(filename, ev.timestamp);
      }
    }
    return json({
      reports: reports.map(r => ({
        filename: r.filename,
        content: r.content,
        read: readSet.has(r.filename),
        replyTo: r.meta?.replyTo,
        attachments: r.attachments,
        submittedAt: submittedAt.get(r.filename),
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

// Permanently discards a report and everything written alongside it (sidecar,
// attachments, read-state entry). The human's escape hatch for a report an
// agent filed in the wrong session; deletion is final, so the UI confirms first.
async function deleteReport(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const filename = decodeURIComponent(params.filename);
    if (!isSafeAttachmentName(filename) || !filename.endsWith(".md")) {
      return json({ error: "invalid report filename" }, 400);
    }
    const dir = reportsDirFor(ctx, meta.id);
    if (!(await Bun.file(join(dir, filename)).exists())) return json({ error: "report not found" }, 404);
    await deleteNumberedFile(dir, filename);
    await appendAndBroadcast(ctx, meta.id, { kind: "report_deleted", payload: { filename } });
    return json({ ok: true, filename });
  });
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
//
// `?side=before` switches the analysed tree from the session worktree to a
// sibling worktree materialised at the diff base. A separate LSP server runs
// rooted there, so an anchor on a brand-new file (one that didn't exist at
// the base) yields an empty graph rather than an error.
async function getCallGraph(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    try {
      const url = new URL(req.url);
      const anchorPath = (url.searchParams.get("anchorPath") || "").trim() || null;
      const anchorLine = parseIntegerParam(url.searchParams.get("anchorLine"));
      const anchorCharacter = parseIntegerParam(url.searchParams.get("anchorCharacter"));
      const side = parseSideParam(url.searchParams.get("side"));
      const diffBase = await ctx.worktreeOps.resolveDiffBase(meta.worktreePath, meta.baseBranch, meta.baseCommit);
      const diff = await ctx.worktreeOps.gitDiff(meta.worktreePath, diffBase);

      // The LSP's view of the world is its `worktreePath` — the session
      // worktree (HEAD) for After, a detached sibling at the diff base for
      // Before. Both queries share the diff (and so its `changedFiles`); each
      // then restricts that list to files that exist in *its* tree.
      const analysisWorktreePath = side === "before"
        ? await ctx.worktreeOps.ensureBaseWorktree(meta.worktreePath, ctx.repoDir, diffBase)
        : meta.worktreePath;
      const allPaths = await ctx.worktreeOps.listWorktreeFiles(analysisWorktreePath);
      const inWorktree = new Set(allPaths);

      let changedFiles: string[];
      let anchorSymbol: { path: string; line: number; character?: number } | undefined;
      let totalChangedFiles: number;
      let truncated: boolean;
      if (anchorPath && anchorLine !== null) {
        // The symbol-anchor walk doesn't seed from changed files at all — it
        // pins to one function, so a missing anchor file just yields an empty
        // graph (collectCallGraph treats anchorSymbol as advisory).
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
        worktreePath: analysisWorktreePath,
        changedFiles,
        anchorSymbol,
        languageOf: p => structureLanguageOf(p) ?? null,
      });
      return json({
        ...view, truncated, totalChangedFiles,
        anchorPath: anchorPath ?? undefined,
        anchorLine: anchorLine ?? undefined,
        side,
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
      // The image's bytes are not inlined here; the Files tab fetches them from
      // GET /sessions/:id/file/raw, which renders straight into an <img>.
      case "image": return json({ path: relPath, image: true, mediaType: result.mediaType });
      case "binary": return json({ path: relPath, binary: true });
      case "too-large": return json({ path: relPath, tooLarge: true, size: result.size });
      case "not-found": return json({ error: "file not found" }, 404);
      case "not-a-file": return json({ error: "not a file" }, 400);
      case "denied": return json({ error: "path outside worktree" }, 403);
    }
  });
}

// Serves a worktree image file's raw bytes so the Files tab can render it in an
// <img>. Shares GET /sessions/:id/file's `?path=` query and escape checks via
// `readWorktreeFile`; only image-classified files are served, so a request for
// a text or binary path is refused rather than streamed.
async function getFileRaw(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const relPath = new URL(req.url).searchParams.get("path");
    if (!relPath || relPath.trim() === "") return json({ error: "path query is required" }, 400);
    const result = await ctx.worktreeOps.readWorktreeFile(meta.worktreePath, relPath);
    switch (result.kind) {
      case "image": return new Response(result.bytes, { headers: { "content-type": result.mediaType } });
      case "not-found": return json({ error: "file not found" }, 404);
      case "denied": return json({ error: "path outside worktree" }, 403);
      default: return json({ error: "not an image file" }, 400);
    }
  });
}

// The Files tab's editor save: overwrites a worktree file with the body's
// `content`. Mirrors GET /sessions/:id/file — same `?path=` query, same escape
// checks via `writeWorktreeFile` — and only touches existing files (the editor
// opens a file before it can save one).
async function putFile(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const relPath = new URL(req.url).searchParams.get("path");
    if (!relPath || relPath.trim() === "") return json({ error: "path query is required" }, 400);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const content = (body as { content?: unknown })?.content;
    if (typeof content !== "string") return json({ error: "content must be a string" }, 400);
    const result = await ctx.worktreeOps.writeWorktreeFile(meta.worktreePath, relPath, content);
    switch (result.kind) {
      case "ok": return json({ path: relPath, ok: true });
      case "not-found": return json({ error: "file not found" }, 404);
      case "not-a-file": return json({ error: "not a file" }, 400);
      case "denied": return json({ error: "path outside worktree" }, 403);
    }
  });
}

// The Files tab's "new file": creates a brand-new worktree file from the
// body's `path` (with optional initial `content`). POSTs to the collection
// rather than reusing PUT's `?path=` because the path is the new resource's
// identifier, not a known target. PUT handles overwriting; this only creates.
async function postFile(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const path = (body as { path?: unknown })?.path;
    if (typeof path !== "string" || path.trim() === "") return json({ error: "path is required" }, 400);
    const content = (body as { content?: unknown })?.content;
    if (content !== undefined && typeof content !== "string") return json({ error: "content must be a string" }, 400);
    const result = await ctx.worktreeOps.createWorktreeFile(meta.worktreePath, path, content ?? "");
    switch (result.kind) {
      case "ok": return json({ path, ok: true });
      case "exists": return json({ error: "file already exists" }, 409);
      case "denied": return json({ error: "path outside worktree" }, 403);
    }
  });
}

// The Files tab's delete: removes the worktree file named by `?path=` (same
// query shape as GET/PUT).
async function deleteFile(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const relPath = new URL(req.url).searchParams.get("path");
    if (!relPath || relPath.trim() === "") return json({ error: "path query is required" }, 400);
    const result = await ctx.worktreeOps.deleteWorktreeFile(meta.worktreePath, relPath);
    switch (result.kind) {
      case "ok": return json({ path: relPath, ok: true });
      case "not-found": return json({ error: "file not found" }, 404);
      case "not-a-file": return json({ error: "not a file" }, 400);
      case "denied": return json({ error: "path outside worktree" }, 403);
    }
  });
}

// The Files tab's rename: moves a worktree file from the body's `from` path to
// its `to` path. A dedicated sub-route rather than overloading the file
// endpoint, since rename names two paths and the others name one.
async function postFileRename(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const from = (body as { from?: unknown })?.from;
    const to = (body as { to?: unknown })?.to;
    if (typeof from !== "string" || from.trim() === "") return json({ error: "from is required" }, 400);
    if (typeof to !== "string" || to.trim() === "") return json({ error: "to is required" }, 400);
    const result = await ctx.worktreeOps.renameWorktreeFile(meta.worktreePath, from, to);
    switch (result.kind) {
      case "ok": return json({ from, to, ok: true });
      case "not-found": return json({ error: "file not found" }, 404);
      case "not-a-file": return json({ error: "not a file" }, 400);
      case "exists": return json({ error: "destination already exists" }, 409);
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

// The PR (if any) tracking this session's branch on the remote. Independent of
// GET /sessions/:id — the resolver may shell out to a CLI over the network, so
// the sidebar prefetches this for every session off its poll, keeping the
// cache warm so an opened session shows its link with no delay. `?fresh=1`
// bypasses the cache (used right after create-pr). Shape mirrors permalink:
// `{ url }` when found, `{ url: null, reason }` otherwise. The branch comes
// from meta; legacy pre-branchName sessions never had a tracking PR.
async function getPrLink(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    if (!meta.branchName) return json({ url: null, reason: "no-pr" });
    const bypassCache = new URL(req.url).searchParams.get("fresh") === "1";
    const result = await ctx.prLinkResolver.resolve({
      worktreePath: meta.worktreePath,
      branchName: meta.branchName,
      bypassCache,
    });
    return json(result);
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
      const file = await writeNumberedFile(inbox, "feedback", prompt, {
        archiveDirs: [feedbackReadDirFor(ctx, meta.id)],
      });
      await appendAndBroadcast(ctx, meta.id, { kind: "feedback_received", payload: { filename: file.filename } });
    }

    const events = await readEvents(meta.id, 1, ctx.sessionsDir);
    const hasBeenStarted = events.some(e => e.kind === "session_started");

    const { endedAt: _endedAt, archivedAt: _archivedAt, ...rest } = meta;
    const resumed: SessionMeta = { ...rest, status: "running" };
    await saveSessionMeta(resumed, ctx.sessionsDir);
    await spawnAndAttachHost(ctx, resumed, { resume: hasBeenStarted });

    if (!hasBeenStarted && prompt !== "") {
      const att = ctx.clients.get(meta.id);
      if (att) {
        att.client.send("[wake] check feedback inbox").catch(() => {});
        scheduleWakeWatchdog(ctx, meta.id, att);
      }
    }

    const stored = await loadSessionMeta(meta.id, ctx.sessionsDir);
    return json({ meta: stored ?? resumed });
  });
}

interface FeedbackBody {
  content: string;
  anchor?: { path: string; lineStart: number; lineEnd?: number; quote?: string };
  slug?: string;
}

// Production defaults for image attachments (feedback and reports alike). The
// browser caps feedback uploads as well so the human gets immediate "too big"
// feedback; the server cap is the authoritative limit and rejects anything
// that slips past.
const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_ATTACHMENT_MAX_COUNT = 5;
const ALLOWED_ATTACHMENT_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const ATTACHMENT_NAME_BAD_CHARS = /[^a-zA-Z0-9._-]+/g;
const ATTACHMENT_NAME_EDGE_DASHES = /^-+|-+$/g;

// Strip directory parts (browsers occasionally include them) and reduce the
// basename to a safe set. The numeric prefix is added by the caller.
function sanitiseAttachmentBasename(rawName: string): string {
  const base = rawName.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(ATTACHMENT_NAME_BAD_CHARS, "-").replace(ATTACHMENT_NAME_EDGE_DASHES, "");
  return cleaned === "" ? "attachment" : cleaned;
}

interface ParsedFeedbackRequest {
  body: FeedbackBody;
  attachments: { name: string; bytes: Uint8Array }[];
}

// A 400 response to send back to the human, paired with no body so the caller
// can `return` it directly.
type FeedbackParseError = { error: string };

// Pulls the image attachments out of a multipart form, enforcing the per-file
// size cap, the per-request count cap, and the allowed-MIME check. Shared by
// the feedback POST and the internal report POST so both directions apply the
// identical limits. Each attachment's on-disk name gets a numeric prefix so
// uploads sharing a basename stay collision-free.
async function parseFormAttachments(
  form: FormData,
  ctx: ServerContext,
): Promise<{ attachments: { name: string; bytes: Uint8Array }[] } | FeedbackParseError> {
  const files = form.getAll("attachment").filter((v): v is File => v instanceof File);
  if (files.length > ctx.attachmentMaxCount) {
    return { error: `too many attachments (max ${ctx.attachmentMaxCount})` };
  }
  const attachments: { name: string; bytes: Uint8Array }[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const mime = (file.type ?? "").toLowerCase();
    if (!ALLOWED_ATTACHMENT_MIMES.has(mime)) {
      return { error: `attachment ${i + 1} is not an allowed image type (${mime || "unknown"})` };
    }
    if (file.size > ctx.attachmentMaxBytes) {
      return { error: `attachment ${i + 1} exceeds the size cap (${file.size} > ${ctx.attachmentMaxBytes} bytes)` };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const prefix = String(i + 1).padStart(2, "0");
    attachments.push({ name: `${prefix}-${sanitiseAttachmentBasename(file.name)}`, bytes });
  }
  return { attachments };
}

async function parseFeedbackRequest(req: Request, ctx: ServerContext): Promise<ParsedFeedbackRequest | FeedbackParseError> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    const body = (await req.json().catch(() => null)) as FeedbackBody | null;
    if (!body || typeof body.content !== "string" || body.content === "") {
      return { error: "content is required" };
    }
    return { body, attachments: [] };
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return { error: `invalid multipart body: ${(err as Error).message}` };
  }
  const payloadField = form.get("payload");
  if (typeof payloadField !== "string" || payloadField === "") {
    return { error: "payload field is required" };
  }
  let body: FeedbackBody;
  try {
    body = JSON.parse(payloadField) as FeedbackBody;
  } catch (err) {
    return { error: `payload is not valid JSON: ${(err as Error).message}` };
  }
  if (!body || typeof body.content !== "string" || body.content === "") {
    return { error: "content is required" };
  }

  const parsed = await parseFormAttachments(form, ctx);
  if ("error" in parsed) return parsed;
  return { body, attachments: parsed.attachments };
}

interface ParsedReportRequest {
  body: NumberedBody | null;
  attachments: { name: string; bytes: Uint8Array }[];
}

// Reports accept the same JSON body as before, plus an optional multipart form
// (`payload` JSON + `attachment` files) when the agent attaches images via
// `worqload report submit --image`.
async function parseReportRequest(req: Request, ctx: ServerContext): Promise<ParsedReportRequest | FeedbackParseError> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    const body = (await req.json().catch(() => null)) as NumberedBody | null;
    return { body, attachments: [] };
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return { error: `invalid multipart body: ${(err as Error).message}` };
  }
  const payloadField = form.get("payload");
  if (typeof payloadField !== "string" || payloadField === "") {
    return { error: "payload field is required" };
  }
  let body: NumberedBody;
  try {
    body = JSON.parse(payloadField) as NumberedBody;
  } catch (err) {
    return { error: `payload is not valid JSON: ${(err as Error).message}` };
  }

  const parsed = await parseFormAttachments(form, ctx);
  if ("error" in parsed) return parsed;
  return { body, attachments: parsed.attachments };
}

async function postFeedback(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const parsed = await parseFeedbackRequest(req, ctx);
    if ("error" in parsed) return json(parsed, 400);
    const { body, attachments } = parsed;
    const slug = body.slug ?? "feedback";
    const writeOpts: WriteNumberedFileOptions = { archiveDirs: [feedbackReadDirFor(ctx, meta.id)] };
    if (body.anchor) {
      const { path, lineStart, lineEnd, quote } = body.anchor;
      const anchorMeta: { path: string; lineStart: number; lineEnd: number; quote?: string } = { path, lineStart, lineEnd: lineEnd && lineEnd > lineStart ? lineEnd : lineStart };
      if (quote) anchorMeta.quote = quote;
      writeOpts.meta = { anchor: anchorMeta };
    }
    if (attachments.length > 0) writeOpts.attachments = attachments;
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
    } else if (!isTerminal(meta.status)) {
      // The session is non-terminal but we have no live attachment — the wake
      // would otherwise be silently dropped. Respawn so the agent picks up the
      // feedback we just queued.
      await respawnMissingClient(ctx, meta, "feedback_no_client");
    }

    return json({ filename: file.filename, seq: file.seq });
  });
}

interface FeedbackBatchBody {
  items: FeedbackBody[];
}

async function postFeedbackBatch(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const raw = await req.json().catch(() => null) as FeedbackBatchBody | null;
    if (!raw || !Array.isArray(raw.items) || raw.items.length === 0) {
      return json({ error: "items array is required and must not be empty" }, 400);
    }
    for (const item of raw.items) {
      if (typeof item.content !== "string" || item.content === "") {
        return json({ error: "each item must have a non-empty content string" }, 400);
      }
    }

    const inbox = feedbackInboxDirFor(ctx, meta.id);
    const results: { filename: string; seq: number }[] = [];

    for (const item of raw.items) {
      const slug = item.slug ?? "feedback";
      const writeOpts: WriteNumberedFileOptions = { archiveDirs: [feedbackReadDirFor(ctx, meta.id)] };
      if (item.anchor) {
        const { path, lineStart, lineEnd, quote } = item.anchor;
        const anchorMeta: { path: string; lineStart: number; lineEnd: number; quote?: string } = { path, lineStart, lineEnd: lineEnd && lineEnd > lineStart ? lineEnd : lineStart };
        if (quote) anchorMeta.quote = quote;
        writeOpts.meta = { anchor: anchorMeta };
      }
      const file = await writeNumberedFile(inbox, slug, item.content, writeOpts);
      await appendAndBroadcast(ctx, meta.id, { kind: "feedback_received", payload: { filename: file.filename } });
      results.push({ filename: file.filename, seq: file.seq });
    }

    const att = ctx.clients.get(meta.id);
    appendHostLog(ctx, meta.id, "wake_sent", {
      filenames: results.map(r => r.filename),
      count: results.length,
      hasClient: att !== undefined,
      status: meta.status,
    });
    if (att) {
      att.client.send("[wake] check feedback inbox").catch(() => {});
      scheduleWakeWatchdog(ctx, meta.id, att);
    } else if (!isTerminal(meta.status)) {
      await respawnMissingClient(ctx, meta, "feedback_batch_no_client");
    }

    return json({ results });
  });
}

interface ResolveBody {
  content?: string;
  decision?: "approve" | "reject";
}

async function parseEscalationResolveRequest(req: Request, ctx: ServerContext): Promise<{ body: ResolveBody; attachments: { name: string; bytes: Uint8Array }[] } | FeedbackParseError> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    const body = (await req.json().catch(() => ({}))) as ResolveBody;
    return { body, attachments: [] };
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return { error: `invalid multipart body: ${(err as Error).message}` };
  }
  const payloadField = form.get("payload");
  if (typeof payloadField !== "string" || payloadField === "") {
    return { error: "payload field is required" };
  }
  let body: ResolveBody;
  try {
    body = JSON.parse(payloadField) as ResolveBody;
  } catch (err) {
    return { error: `payload is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = await parseFormAttachments(form, ctx);
  if ("error" in parsed) return parsed;
  return { body, attachments: parsed.attachments };
}

async function postEscalationResolve(req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const askingDir = askingDirFor(ctx, meta.id);
    const askingFilePath = join(askingDir, params.filename);
    const askingFile = Bun.file(askingFilePath);
    if (!(await askingFile.exists())) {
      return json({ error: "escalation not found" }, 404);
    }

    const parsed = await parseEscalationResolveRequest(req, ctx);
    if ("error" in parsed) return json(parsed, 400);
    const { body, attachments } = parsed;
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
      let agentReason = "";
      let timeoutMs: number | undefined;
      try {
        const sidecar = (await sidecarFile.json()) as CommandApproval;
        command = sidecar.command ?? "";
        agentReason = sidecar.reason ?? "";
        timeoutMs = sidecar.timeoutMs;
      } catch { /* corrupt sidecar */ }
      await moveFile(askingFilePath, join(resolvedDir, params.filename));
      await moveFile(sidecarPath, join(resolvedDir, commandSidecarFilename(params.filename)));
      const note = typeof body.content === "string" ? body.content.trim() : "";
      if (decision === "approve") {
        runResult = await runApprovedCommand(command, meta.worktreePath, timeoutMs);
        feedbackContent = formatApprovedCommandFeedback(params.filename, command, agentReason, runResult, note);
      } else {
        feedbackContent = formatRejectedCommandFeedback(params.filename, command, agentReason, note);
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

    const syncWaiter = isCommandApproval
      ? ctx.commandApprovalWaiters.get(`${meta.id}/${params.filename}`)
      : undefined;

    if (syncWaiter) {
      syncWaiter.resolve({
        decision: body.decision as "approve" | "reject",
        feedbackContent,
        runResult,
      });
      await appendAndBroadcast(ctx, meta.id, {
        kind: "escalation_resolved",
        payload: resolvedPayload,
      });
      const remaining = await listAllFiles(askingDir);
      let updatedMeta = meta;
      if (remaining.length === 0 && meta.status === "waiting_human") {
        updatedMeta = await transitionStatus(ctx, meta, "running");
      }
      return json({
        ok: true,
        decision: body.decision,
        ...(runResult ? { exitCode: runResult.exitCode, stdout: runResult.stdout, stderr: runResult.stderr } : {}),
        meta: updatedMeta,
      });
    }

    const inbox = feedbackInboxDirFor(ctx, meta.id);
    const writeOpts: WriteNumberedFileOptions = { archiveDirs: [feedbackReadDirFor(ctx, meta.id)] };
    if (attachments.length > 0) writeOpts.attachments = attachments;
    const file = await writeNumberedFile(inbox, slug, feedbackContent, writeOpts);
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
  return withSession(ctx, params.id, async meta => {
    const builtinActions = listAvailableActions({ meta, repoDir: ctx.repoDir });
    const skillButtons = await currentSkillButtons(ctx);
    const skillActions = skillButtons.map(skillButtonToDescriptor);
    return json({ actions: [...builtinActions, ...skillActions] });
  });
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
    const parsed = await parseReportRequest(req, ctx);
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    const { body, attachments } = parsed;
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
    // Revise mode (opt-in per session): hold the first submission of each
    // report and bounce it back asking the session to tighten it, so the 推敲
    // is done by the session — which holds the full context the report
    // describes — rather than a context-blind rewriter. The resubmission
    // passes through. revisionPending marks which half of the cycle we are in.
    if (isReviseModeEnabled(meta)) {
      // textlint runs on every submission under revise mode and gates storage,
      // so the stored report is guaranteed clean. A violation bounces without
      // touching revisionPending — it is orthogonal to the general one-shot
      // revision cycle below and may fire on the first or a later submission.
      const violations = lintReport(body.content, await currentTextlintRules(ctx), await currentTextlintTokenizer(ctx));
      if (violations.length > 0) {
        return bounceReportForRevision(ctx, meta, body, buildTextlintBounceFeedback(body.slug, violations), "report_textlint_rejected");
      }
      // First submission of each report (textlint-clean): hold it for one
      // general tightening pass. The resubmission passes through. revisionPending
      // marks which half of the cycle we are in.
      if (meta.revisionPending !== true) {
        await saveSessionMeta({ ...meta, revisionPending: true }, ctx.sessionsDir);
        const guidance = (await currentReviseFeedbackGuidance(ctx)) ?? undefined;
        return bounceReportForRevision(ctx, meta, body, buildRevisionRequestFeedback(body.slug, guidance), "report_revision_requested");
      }
    }
    // The resubmission, or revise mode off: clear any pending flag and store.
    if (meta.revisionPending === true) {
      await saveSessionMeta({ ...meta, revisionPending: false }, ctx.sessionsDir);
    }
    const dir = reportsDirFor(ctx, meta.id);
    // Reports bounced for revision returned above, so attachments are written
    // only alongside a report that is actually stored.
    const writeOpts: WriteNumberedFileOptions = {};
    if (replyTo) writeOpts.meta = { replyTo };
    if (attachments.length > 0) writeOpts.attachments = attachments;
    const file = await writeNumberedFile(dir, body.slug, body.content, writeOpts);
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
  sync?: boolean;
  timeoutMs?: number;
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
    const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : undefined;
    await Bun.write(join(dir, commandSidecarFilename(file.filename)), JSON.stringify({ command: body.command, ...(reason ? { reason } : {}), ...(timeoutMs ? { timeoutMs } : {}) }, null, 2));
    if (!isTerminal(meta.status) && meta.status !== "waiting_human") {
      await transitionStatus(ctx, meta, "waiting_human");
    }
    await appendAndBroadcast(ctx, meta.id, {
      kind: "escalation_requested",
      payload: { filename: file.filename, command: body.command },
    });
    if (!body.sync) {
      return json({ filename: file.filename, seq: file.seq });
    }
    const waiterKey = `${meta.id}/${file.filename}`;
    const { promise, resolve } = Promise.withResolvers<CommandApprovalSyncResult>();
    ctx.commandApprovalWaiters.set(waiterKey, { resolve });
    try {
      const syncResult = await promise;
      return json({
        filename: file.filename,
        seq: file.seq,
        decision: syncResult.decision,
        feedbackContent: syncResult.feedbackContent,
        ...(syncResult.runResult ? {
          exitCode: syncResult.runResult.exitCode,
          stdout: syncResult.runResult.stdout,
          stderr: syncResult.runResult.stderr,
          timedOut: syncResult.runResult.timedOut,
        } : {}),
      });
    } finally {
      ctx.commandApprovalWaiters.delete(waiterKey);
    }
  });
}

// Trailing section appended to a feedback message body whenever the human
// attached one or more images. Phrased so the agent reaches for the Read tool
// (which renders images as multimodal input) without guessing at intent.
function formatAttachmentsSection(absolutePaths: string[]): string {
  const noun = absolutePaths.length === 1 ? "1 image" : `${absolutePaths.length} images`;
  const lead = `The human attached ${noun}. Read each with the Read tool:`;
  const lines = absolutePaths.map(p => `- ${p}`).join("\n");
  return `## Attachments\n\n${lead}\n\n${lines}`;
}

function formatFeedbackMessageForAgent(m: { content: string; filename: string; meta?: { anchor?: { path: string; lineStart: number; lineEnd: number; quote?: string } }; attachments?: string[] }, attachmentsBaseDir: string, skills?: SkillButton[]): { filename: string; content: string } {
  let content = m.meta?.anchor ? `${formatAnchorRefLine(m.meta.anchor)}\n\n${m.content}` : m.content;
  if (skills && skills.length > 0) {
    content = expandSkillReferences(content, skills);
  }
  if (m.attachments && m.attachments.length > 0) {
    const dir = join(attachmentsBaseDir, attachmentsDirNameFor(m.filename));
    const paths = m.attachments.map(name => join(dir, name));
    content = `${content}\n\n${formatAttachmentsSection(paths)}`;
  }
  return { filename: m.filename, content };
}

async function getInternalFeedback(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    // The agent checking its inbox — drained or not — is the wake watchdog's
    // proof of delivery: it disambiguates "inbox empty because fetched" from
    // "inbox empty because nothing was queued".
    ctx.lastFeedbackFetchAt.set(meta.id, Date.now());
    const inbox = feedbackInboxDirFor(ctx, meta.id);
    const readDir = feedbackReadDirFor(ctx, meta.id);
    const messages = await listAllFiles(inbox);
    for (const m of messages) {
      await moveNumberedFile(inbox, readDir, m.filename);
    }
    if (messages.length > 0) {
      await appendAndBroadcast(ctx, meta.id, { kind: "feedback_fetched", payload: { count: messages.length } });
    }
    const skills = await currentSkillButtons(ctx);
    return json({
      messages: messages.map(m => formatFeedbackMessageForAgent(m, readDir, skills)),
    });
  });
}

async function getInternalFeedbackHistory(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const inboxDir = feedbackInboxDirFor(ctx, meta.id);
    const readDir = feedbackReadDirFor(ctx, meta.id);
    const inbox = await listAllFiles(inboxDir);
    const read = await listAllFiles(readDir);
    const all = [
      ...inbox.map(f => ({ ...formatFeedbackMessageForAgent(f, inboxDir), status: "unread" as const })),
      ...read.map(f => ({ ...formatFeedbackMessageForAgent(f, readDir), status: "read" as const })),
    ];
    all.sort((a, b) => a.filename.localeCompare(b.filename));
    return json({ messages: all });
  });
}

async function getInternalFeedbackByFilename(_req: Request, ctx: ServerContext, params: Record<string, string>): Promise<Response> {
  return withSession(ctx, params.id, async meta => {
    const { filename } = params;
    const inboxDir = feedbackInboxDirFor(ctx, meta.id);
    const readDir = feedbackReadDirFor(ctx, meta.id);

    const skills = await currentSkillButtons(ctx);
    const inboxFiles = await listAllFiles(inboxDir);
    const inInbox = inboxFiles.find(f => f.filename === filename);
    if (inInbox) {
      await moveNumberedFile(inboxDir, readDir, filename);
      return json({ message: formatFeedbackMessageForAgent(inInbox, readDir, skills) });
    }

    const readFiles = await listAllFiles(readDir);
    const inRead = readFiles.find(f => f.filename === filename);
    if (inRead) {
      return json({ message: formatFeedbackMessageForAgent(inRead, readDir, skills) });
    }

    return json({ error: `feedback not found: ${filename}` }, 404);
  });
}
