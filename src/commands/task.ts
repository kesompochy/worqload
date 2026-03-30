import { createTask } from "../task";
import type { TaskStatus } from "../task";
import type { TaskQueue } from "../queue";
import { parseFlags } from "../utils/args";
import { resolveTask } from "./resolve";

export async function add(queue: TaskQueue, args: string[]) {
  const { flags, rest } = parseFlags(args, ["--priority", "--by"]);
  const priority = flags["--priority"] ? Number(flags["--priority"]) : 0;
  if (flags["--priority"] && !Number.isFinite(priority)) {
    console.error("Priority must be a number.");
    process.exit(1);
  }
  const createdBy = flags["--by"];
  const title = rest.join(" ").trim();
  if (!title) {
    console.error("Usage: worqload add <title> [--priority N] [--by <creator>]");
    process.exit(1);
  }
  const task = createTask(title, {}, priority, createdBy);
  queue.enqueue(task);
  await queue.save();
  const byLabel = createdBy ? ` by:${createdBy}` : "";
  console.log(`Added: ${task.title} (${task.id.slice(0, 8)}) [priority: ${priority}]${byLabel}`);
}

export async function list(queue: TaskQueue, args: string[]) {
  const validStatuses: TaskStatus[] = ["pending", "observing", "orienting", "deciding", "waiting_human", "acting", "done", "failed"];
  const statusFilter = args[0] as TaskStatus | undefined;
  if (statusFilter && !validStatuses.includes(statusFilter)) {
    console.error(`Invalid status: ${statusFilter}`);
    console.error(`Valid statuses: ${validStatuses.join(", ")}`);
    process.exit(1);
  }
  const tasks = statusFilter ? queue.list().filter(t => t.status === statusFilter) : queue.list();
  if (tasks.length === 0) {
    console.log("No tasks.");
    return;
  }
  for (const task of tasks) {
    const priorityLabel = task.priority !== 0 ? ` p:${task.priority}` : "";
    const ownerLabel = task.owner ? ` @${task.owner}` : "";
    const createdByLabel = task.createdBy ? ` by:${task.createdBy}` : "";
    console.log(`[${task.status.padEnd(13)}] ${task.title} (${task.id.slice(0, 8)})${priorityLabel}${ownerLabel}${createdByLabel}`);
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
    console.error("Usage: worqload context <id> <key> <value>");
    process.exit(1);
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
    console.log("No pending tasks.");
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
    console.log(`[${task.status.padEnd(13)}] ${task.title} (${task.id.slice(0, 8)})`);
  }
}

export async function claim(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  const owner = args[1];
  if (!owner) {
    console.error("Usage: worqload claim <id> <owner>");
    process.exit(1);
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
