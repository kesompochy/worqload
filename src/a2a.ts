import type { Task, TaskStatus } from "./task";
import { createTask, getHumanQuestion, HUMAN_REQUIRED_PREFIX } from "./task";
import { TaskQueue } from "./queue";

// A2A Protocol types (spec v0.2.1)

export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

export interface TextPart {
  kind: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface FilePart {
  kind: "file";
  file: { bytes: string; mime_type?: string; name?: string } | { uri: string; mime_type?: string; name?: string };
  metadata?: Record<string, unknown>;
}

export interface DataPart {
  kind: "data";
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

export interface A2AMessage {
  message_id: string;
  role: "user" | "agent";
  parts: Part[];
  task_id?: string | null;
  context_id?: string | null;
  metadata?: Record<string, unknown> | null;
  kind: "message";
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage | null;
  timestamp?: string;
}

export interface A2AArtifact {
  artifact_id: string;
  parts: Part[];
  name?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface A2ATask {
  kind: "task";
  id: string;
  context_id: string;
  status: A2ATaskStatus;
  history?: A2AMessage[];
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown> | null;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  url: string;
  protocol_version: string;
  capabilities: {
    streaming: boolean;
    push_notifications: boolean;
    state_transition_history: boolean;
  };
  default_input_modes: string[];
  default_output_modes: string[];
  skills: AgentSkill[];
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Error codes per A2A spec
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const TASK_NOT_FOUND = -32001;
const TASK_NOT_CANCELABLE = -32002;

// State mapping: worqload → A2A
const STATE_MAP: Record<TaskStatus, A2ATaskState> = {
  observing: "working",
  orienting: "working",
  deciding: "working",
  acting: "working",
  waiting_human: "input-required",
  done: "completed",
  failed: "failed",
};

export function toA2AState(status: TaskStatus): A2ATaskState {
  return STATE_MAP[status];
}

export function toA2ATask(task: Task): A2ATask {
  const contextId = (task.context as Record<string, unknown>).a2a_context_id as string | undefined;
  const history: A2AMessage[] = [];

  const originalMessage = (task.context as Record<string, unknown>).a2a_original_message as A2AMessage | undefined;
  if (originalMessage) {
    history.push(originalMessage);
  }

  for (const log of task.logs) {
    history.push({
      message_id: `log-${log.timestamp}`,
      role: "agent",
      parts: [{ kind: "text", text: `[${log.phase}] ${log.content}` }],
      kind: "message",
    });
  }

  const status: A2ATaskStatus = {
    state: toA2AState(task.status),
    timestamp: task.updatedAt,
  };

  const humanQuestion = getHumanQuestion(task);
  if (humanQuestion) {
    const humanLog = [...task.logs].reverse().find(
      (log) => log.content.startsWith(HUMAN_REQUIRED_PREFIX)
    );
    if (humanLog) {
      status.message = {
        message_id: `log-${humanLog.timestamp}`,
        role: "agent",
        parts: [{ kind: "text", text: humanQuestion }],
        kind: "message",
      };
    }
  }

  const a2aTask: A2ATask = {
    kind: "task",
    id: task.id,
    context_id: contextId ?? task.id,
    status,
  };

  if (history.length > 0) {
    a2aTask.history = history;
  }

  return a2aTask;
}

export function generateAgentCard(serverUrl: string): AgentCard {
  return {
    name: "worqload",
    description: "OODA-loop based task queue for AI agents. Manages task lifecycle through Observe, Orient, Decide, Act phases.",
    version: "0.1.0",
    url: serverUrl,
    protocol_version: "0.2.1",
    capabilities: {
      streaming: false,
      push_notifications: false,
      state_transition_history: true,
    },
    default_input_modes: ["text/plain"],
    default_output_modes: ["text/plain"],
    skills: [
      {
        id: "task-management",
        name: "Task Management",
        description: "Create and manage tasks through an OODA-loop lifecycle (Observe, Orient, Decide, Act)",
        tags: ["task", "ooda", "queue", "workflow"],
        examples: [
          "Create a new task to investigate the login bug",
          "What is the status of my tasks?",
        ],
      },
    ],
  };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function extractTextFromParts(parts: Part[]): string {
  return parts
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text)
    .join("\n");
}

async function handleMessageSend(queue: TaskQueue, params: Record<string, unknown>): Promise<A2ATask> {
  const message = params.message as A2AMessage | undefined;
  if (!message || !message.parts || message.parts.length === 0) {
    throw { code: INVALID_REQUEST, message: "message with parts is required" };
  }

  const text = extractTextFromParts(message.parts);

  // Reply to an existing task
  if (message.task_id) {
    await queue.load();
    const existing = queue.get(message.task_id) ?? queue.findById(message.task_id);
    if (!existing) {
      throw { code: TASK_NOT_FOUND, message: `Task not found: ${message.task_id}` };
    }
    if (existing.status !== "waiting_human") {
      throw { code: INVALID_REQUEST, message: `Task is not waiting for human input (current: ${existing.status})` };
    }
    queue.addLog(existing.id, "decide", text);
    queue.transition(existing.id, "deciding");
    await queue.save();
    return toA2ATask(queue.get(existing.id)!);
  }

  // Create a new task
  const title = text || "A2A task";
  await queue.load();
  const task = createTask(title, {
    a2a_context_id: message.context_id ?? undefined,
    a2a_original_message: message,
  }, 0, "a2a");
  queue.enqueue(task);
  await queue.save();

  return toA2ATask(task);
}

async function handleTasksGet(queue: TaskQueue, params: Record<string, unknown>): Promise<A2ATask> {
  const taskId = params.id as string | undefined;
  if (!taskId) {
    throw { code: INVALID_REQUEST, message: "id is required" };
  }

  await queue.load();
  const task = queue.get(taskId) ?? queue.findById(taskId);
  if (!task) {
    throw { code: TASK_NOT_FOUND, message: `Task not found: ${taskId}` };
  }

  return toA2ATask(task);
}

async function handleTasksCancel(queue: TaskQueue, params: Record<string, unknown>): Promise<A2ATask> {
  const taskId = params.id as string | undefined;
  if (!taskId) {
    throw { code: INVALID_REQUEST, message: "id is required" };
  }

  await queue.load();
  const task = queue.get(taskId) ?? queue.findById(taskId);
  if (!task) {
    throw { code: TASK_NOT_FOUND, message: `Task not found: ${taskId}` };
  }

  if (task.status === "done" || task.status === "failed") {
    throw { code: TASK_NOT_CANCELABLE, message: `Task is already ${task.status}` };
  }

  queue.addLog(task.id, "act", "[CANCELED via A2A]");
  queue.transition(task.id, "failed");
  await queue.save();

  const updated = queue.get(task.id)!;
  return toA2ATask(updated);
}

export async function handleA2ARequest(queue: TaskQueue, body: unknown): Promise<JsonRpcResponse> {
  if (typeof body !== "object" || body === null) {
    return rpcError(null, PARSE_ERROR, "Invalid JSON");
  }

  const req = body as Partial<JsonRpcRequest>;
  if (req.jsonrpc !== "2.0" || !req.method || req.id === undefined) {
    return rpcError(req.id ?? null, INVALID_REQUEST, "Invalid JSON-RPC request");
  }

  const params = req.params ?? {};

  try {
    switch (req.method) {
      case "message/send": {
        const result = await handleMessageSend(queue, params);
        return rpcResult(req.id!, result);
      }
      case "tasks/get": {
        const result = await handleTasksGet(queue, params);
        return rpcResult(req.id!, result);
      }
      case "tasks/cancel": {
        const result = await handleTasksCancel(queue, params);
        return rpcResult(req.id!, result);
      }
      default:
        return rpcError(req.id!, METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
    }
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
      const rpcErr = err as JsonRpcError;
      return rpcError(req.id!, rpcErr.code, rpcErr.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    return rpcError(req.id!, -32603, message);
  }
}
