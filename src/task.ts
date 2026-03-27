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
  context: Record<string, unknown>;
  logs: PhaseLog[];
  createdAt: string;
  updatedAt: string;
}

export function createTask(title: string, context: Record<string, unknown> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title,
    status: "pending",
    context,
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
}
