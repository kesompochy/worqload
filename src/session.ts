import { loadJsonFile, saveJsonFile } from "./utils/json-store";

export type SessionStatus = "running" | "waiting_human" | "stopped" | "crashed";
export type AgentName = "claude" | "codex" | "cursor";

export type DriverName = "pipe" | "tmux";

export type DriverName = "pipe" | "tmux";

export interface SessionMeta {
  id: string;
  title?: string;
  prompt: string;
  baseBranch: string;
  baseCommit: string;
  worktreePath: string;
  branchName: string;
  agentName?: AgentName;
  driverName?: DriverName;
  model?: string;
  hostPid?: number;
  hostSocketPath?: string;
  status: SessionStatus;
  createdAt: string;
  endedAt?: string;
  archivedAt?: string;
  // Position in the sidebar after the human drag-reorders the list. Sessions
  // without it (never reordered, or created since the last reorder) sort to the
  // top by recency; sessions with it sort below by ascending value.
  sortOrder?: number;
  // Marks a curated example session (the preview repo seeds three of them).
  // The server skips the reconcile-on-boot step for these so a running mock
  // doesn't get auto-flipped to crashed for lacking a real host process.
  mock?: boolean;
  // Whether worqload holds the first submission of each report and bounces it
  // back asking the session to revise it before storing. Absent means disabled:
  // revise mode is off by default, so a session's reports are stored on first
  // submission. The human flips it on per session from the UI.
  reviseModeEnabled?: boolean;
  // Tracks which half of the revise-mode cycle the next report submission is
  // in. Set when a first submission is bounced for revision; cleared when the
  // resubmission is stored. Only meaningful while reviseModeEnabled is on.
  revisionPending?: boolean;
  // Agent-side conversation identifier the driver wants restored on a future
  // host respawn. Today: codex's thread_id (captured from `thread.started` and
  // re-sent via `codex exec --json resume <id>`) or cursor's session_id
  // (re-sent via `agent --resume <id>`). Claude resumes via its own
  // `--continue` flag and does not set this field.
  agentSessionId?: string;
}

// `reviseModeEnabled` is opt-in: only an explicit `true` (the human toggled
// it on for this session) enables the forced revision pass. Undefined — a new
// session, or any created before the flag existed — stays disabled.
export function isReviseModeEnabled(meta: SessionMeta): boolean {
  return meta.reviseModeEnabled === true;
}

const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  running: ["waiting_human", "stopped", "crashed"],
  waiting_human: ["running", "stopped", "crashed"],
  // A terminal session re-enters "running" only via resume (a fresh host on
  // the preserved worktree, continuing the prior claude conversation).
  stopped: ["running"],
  crashed: ["running"],
};

export function validateTransition(from: SessionStatus, to: SessionStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid status transition: ${from} → ${to}`);
  }
}

export function isTerminal(status: SessionStatus): boolean {
  return status === "stopped" || status === "crashed";
}

export interface CreateSessionParams {
  prompt: string;
  baseBranch: string;
  baseCommit: string;
  worktreePath: string;
  branchName: string;
  agentName?: AgentName;
  driverName?: DriverName;
  model?: string;
  title?: string;
}

export function createSession(params: CreateSessionParams): SessionMeta {
  const trimmed = params.prompt.trim();
  if (trimmed === "") {
    throw new Error("prompt must not be empty");
  }
  return {
    id: crypto.randomUUID(),
    ...(params.title !== undefined && { title: params.title }),
    prompt: trimmed,
    baseBranch: params.baseBranch,
    baseCommit: params.baseCommit,
    worktreePath: params.worktreePath,
    branchName: params.branchName,
    ...(params.agentName !== undefined && { agentName: params.agentName }),
    ...(params.driverName !== undefined && { driverName: params.driverName }),
    ...(params.model !== undefined && { model: params.model }),
    status: "running",
    createdAt: new Date().toISOString(),
  };
}

export const DEFAULT_SESSIONS_DIR = ".worqload/sessions";

function metaPath(sessionsDir: string, id: string): string {
  return `${sessionsDir}/${id}/meta.json`;
}

// Path of the file holding the current serve base URL for a session.
export function agentEndpointPath(sessionsDir: string, sessionId: string): string {
  return `${sessionsDir}/${sessionId}/agent-endpoint`;
}

// JSONL log file the host and serve both append to for diagnosing wake-path
// failures (host's stderr is redirected here; serve writes "wake_sent" entries
// when forwarding feedback). Each line is `{"ts","source","event",...}`.
export function hostLogPath(sessionsDir: string, sessionId: string): string {
  return `${sessionsDir}/${sessionId}/host.log`;
}

export async function saveSessionMeta(
  meta: SessionMeta,
  sessionsDir: string = DEFAULT_SESSIONS_DIR,
): Promise<void> {
  await saveJsonFile(metaPath(sessionsDir, meta.id), meta);
}

export async function loadSessionMeta(
  id: string,
  sessionsDir: string = DEFAULT_SESSIONS_DIR,
): Promise<SessionMeta | null> {
  return loadJsonFile<SessionMeta | null>(metaPath(sessionsDir, id), null);
}

export async function listSessionMetas(
  sessionsDir: string = DEFAULT_SESSIONS_DIR,
): Promise<SessionMeta[]> {
  const { readdir } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const metas: SessionMeta[] = [];
  for (const id of entries) {
    const meta = await loadSessionMeta(id, sessionsDir);
    if (meta) metas.push(meta);
  }
  return metas.sort(compareSessionOrder);
}

// Sidebar order: a session the human placed explicitly (sortOrder set) sits
// where they put it; one without — including any created after the last
// reorder — floats to the top by recency, so new work stays visible.
function compareSessionOrder(a: SessionMeta, b: SessionMeta): number {
  const ao = a.sortOrder;
  const bo = b.sortOrder;
  if (ao !== undefined && bo !== undefined) return ao - bo;
  if (ao === undefined && bo === undefined) return b.createdAt.localeCompare(a.createdAt);
  return ao === undefined ? -1 : 1;
}

// Persist the human's drag-reordered sidebar order by stamping each session's
// meta with its index in `orderedIds`. Ids with no session on disk are skipped.
export async function reorderSessions(
  orderedIds: string[],
  sessionsDir: string = DEFAULT_SESSIONS_DIR,
): Promise<void> {
  for (let index = 0; index < orderedIds.length; index++) {
    const meta = await loadSessionMeta(orderedIds[index], sessionsDir);
    if (meta) await saveSessionMeta({ ...meta, sortOrder: index }, sessionsDir);
  }
}
