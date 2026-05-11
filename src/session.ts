import { loadJsonFile, saveJsonFile } from "./utils/json-store";

export type SessionStatus = "running" | "waiting_human" | "stopped" | "crashed";

export interface SessionMeta {
  id: string;
  title?: string;
  prompt: string;
  baseBranch: string;
  baseCommit: string;
  worktreePath: string;
  hostPid?: number;
  hostSocketPath?: string;
  status: SessionStatus;
  createdAt: string;
  endedAt?: string;
  archivedAt?: string;
}

const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  running: ["waiting_human", "stopped", "crashed"],
  waiting_human: ["running", "stopped", "crashed"],
  stopped: [],
  crashed: [],
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
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
