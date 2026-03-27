export type TaskStatus = "pending" | "observing" | "orienting" | "deciding" | "waiting_human" | "acting" | "done" | "failed";

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
  context: Record<string, unknown>;
  logs: PhaseLog[];
  createdAt: string;
  updatedAt: string;
}

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["observing", "done", "failed"],
  observing: ["orienting", "done", "failed"],
  orienting: ["deciding", "waiting_human", "done", "failed"],
  deciding: ["acting", "waiting_human", "done", "failed"],
  waiting_human: ["deciding", "done", "failed"],
  acting: ["done", "failed"],
  done: [],
  failed: ["pending"],
};

export function validateTransition(from: TaskStatus, to: TaskStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid status transition: ${from} → ${to}`);
  }
}

export function createTask(title: string, context: Record<string, unknown> = {}, priority = 0): Task {
  const trimmed = title.trim();
  if (trimmed === "") {
    throw new Error("Task title must not be empty");
  }
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: trimmed,
    status: "pending",
    priority,
    context,
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
}
