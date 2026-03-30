export type TaskStatus = "observing" | "orienting" | "deciding" | "waiting_human" | "acting" | "done" | "failed";

export const SHORT_ID_LENGTH = 8;

export type OodaPhase = "observe" | "orient" | "decide" | "act";

export interface PhaseLog {
  phase: OodaPhase;
  content: string;
  timestamp: string;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  owner?: string;
  createdBy?: string;
  missionId?: string;
  context: Record<string, unknown>;
  logs: PhaseLog[];
  createdAt: string;
  updatedAt: string;
}

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  observing: ["orienting", "done", "failed"],
  orienting: ["deciding", "waiting_human", "done", "failed"],
  deciding: ["acting", "waiting_human", "done", "failed"],
  waiting_human: ["deciding", "done", "failed"],
  acting: ["done", "failed"],
  done: [],
  failed: ["observing"],
};

export function validateTransition(from: TaskStatus, to: TaskStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid status transition: ${from} → ${to}`);
  }
}

export const HUMAN_REQUIRED_PREFIX = "[HUMAN REQUIRED] ";

export function getHumanQuestion(task: Task): string | null {
  if (task.status !== "waiting_human") return null;
  for (let i = task.logs.length - 1; i >= 0; i--) {
    const log = task.logs[i];
    if (log.content.startsWith(HUMAN_REQUIRED_PREFIX)) return log.content.slice(HUMAN_REQUIRED_PREFIX.length);
  }
  return null;
}

export function createTask(title: string, context: Record<string, unknown> = {}, priority = 0, createdBy?: string): Task {
  const trimmed = title.trim();
  if (trimmed === "") {
    throw new Error("Task title must not be empty");
  }
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: trimmed,
    status: "observing",
    priority,
    ...(createdBy !== undefined && { createdBy }),
    context,
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
}
