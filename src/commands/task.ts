import { exitWithError } from "../utils/errors";
import { createTask } from "../task";
import type { TaskStatus } from "../task";
import { SHORT_ID_LENGTH } from "../task";
import type { TaskQueue } from "../queue";
import { parseFlags } from "../utils/args";
import { resolveTask } from "./resolve";

export async function add(queue: TaskQueue, args: string[]) {
  const { flags, rest } = parseFlags(args, ["--priority", "--by"], ["--plan"]);
  const priority = flags["--priority"] ? Number(flags["--priority"]) : 0;
  if (flags["--priority"] && !Number.isFinite(priority)) {
    exitWithError("Priority must be a number.");
  }
  const createdBy = flags["--by"];
  const isPlan = flags["--plan"] === "true";
  const title = rest.join(" ").trim();
  if (!title) {
    exitWithError("Usage: worqload add <title> [--priority N] [--by <creator>] [--plan]");
  }
  if (title.startsWith("-") || /^(add|list|show|done|fail|retry|observe|orient|decide|act|iterate|resume|mission|feedback|report|source|serve|heartbeat|sleep|wake|project|spawn-cleanup|principle)\b/.test(title)) {
    exitWithError(`Rejected: "${title}" looks like a CLI subcommand, not a task title.`);
  }
  const context: Record<string, unknown> = isPlan ? { plan: true } : {};
  const task = createTask(title, context, priority, createdBy);
  queue.enqueue(task);
  await queue.save();
  const byLabel = createdBy ? ` by:${createdBy}` : "";
  const planLabel = isPlan ? " [plan]" : "";
  console.log(`Added: ${task.title} (${task.id.slice(0, SHORT_ID_LENGTH)}) [priority: ${priority}]${byLabel}${planLabel}`);
}

export async function list(queue: TaskQueue, args: string[]) {
  const validStatuses: TaskStatus[] = ["observing", "orienting", "deciding", "waiting_human", "acting", "done", "failed"];
  const statusFilter = args[0] as TaskStatus | undefined;
  if (statusFilter && !validStatuses.includes(statusFilter)) {
    exitWithError(`Invalid status: ${statusFilter}\nValid statuses: ${validStatuses.join(", ")}`);
  }
  const tasks = (statusFilter ? queue.list().filter(t => t.status === statusFilter) : queue.list())
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  if (tasks.length === 0) {
    console.log("No tasks.");
    return;
  }
  for (const task of tasks) {
    const priorityLabel = task.priority !== 0 ? ` p:${task.priority}` : "";
    const ownerLabel = task.owner ? ` @${task.owner}` : "";
    const createdByLabel = task.createdBy ? ` by:${task.createdBy}` : "";
    console.log(`[${task.status.padEnd(13)}] ${task.title} (${task.id.slice(0, SHORT_ID_LENGTH)})${priorityLabel}${ownerLabel}${createdByLabel}`);
  }
}

export async function show(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  console.log(JSON.stringify(task, null, 2));
}

export async function context(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  const key = args[1];
  if (!key) {
    console.log(JSON.stringify(task.context, null, 2));
    return;
  }
  const raw = args.slice(2).join(" ");
  if (!raw) {
    exitWithError("Usage: worqload context <id> <key> <value>");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  queue.update(task.id, { context: { ...task.context, [key]: value } });
  await queue.save();
  console.log(`Context set: ${key} = ${JSON.stringify(value)}`);
}

export async function next(queue: TaskQueue, _args: string[]) {
  const task = queue.dequeue();
  if (!task) {
    console.log("No tasks in queue.");
    return;
  }
  console.log(JSON.stringify(task, null, 2));
}

export async function clean(queue: TaskQueue, _args: string[]) {
  const terminated = queue.list().filter(t => t.status === "done" || t.status === "failed");
  if (terminated.length === 0) {
    console.log("No done/failed tasks to clean.");
    return;
  }
  const archived = await queue.archive(terminated.map(t => t.id));
  console.log(`Archived ${archived.length} task(s).`);
}

export async function history(queue: TaskQueue, _args: string[]) {
  const archived = await queue.history();
  if (archived.length === 0) {
    console.log("No archived tasks.");
    return;
  }
  for (const task of archived) {
    console.log(`[${task.status.padEnd(13)}] ${task.title} (${task.id.slice(0, SHORT_ID_LENGTH)})`);
  }
}

export async function claim(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  const owner = args[1];
  if (!owner) {
    exitWithError("Usage: worqload claim <id> <owner>");
  }
  queue.claim(task.id, owner);
  await queue.save();
  console.log(`Claimed: ${task.title} → ${owner}`);
}

export async function unclaim(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  queue.unclaim(task.id);
  await queue.save();
  console.log(`Unclaimed: ${task.title}`);
}

export async function priority(queue: TaskQueue, args: string[]) {
  if (args.length < 2) {
    exitWithError("Usage: worqload priority <id> <N>");
  }
  const task = resolveTask(queue, args[0]);
  const value = Number(args[1]);
  if (!Number.isFinite(value)) {
    exitWithError("Priority must be a number.");
  }
  queue.update(task.id, { priority: value });
  await queue.save();
  console.log(`Priority: ${task.title} → ${value}`);
}
