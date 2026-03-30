import type { TaskQueue } from "../queue";
import { resolveTask } from "./resolve";

export async function observe(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  const note = args.slice(1).join(" ");
  queue.transition(task.id, "observing");
  if (note) {
    queue.addLog(task.id, "observe", note);
  }
  await queue.save();
  console.log(note ? `Observed: ${task.title}` : `Observing: ${task.title}`);
}

export async function orient(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  const note = args.slice(1).join(" ");
  if (!note) {
    console.error("Usage: worqload orient <id> <analysis>");
    process.exit(1);
  }
  queue.transition(task.id, "orienting");
  queue.addLog(task.id, "orient", note);
  await queue.save();
  console.log(`Oriented: ${task.title}`);
}

export async function decide(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  if (args[1] === "--human") {
    const question = args.slice(2).join(" ") || "Decision required";
    queue.transition(task.id, "waiting_human");
    queue.addLog(task.id, "decide", `[HUMAN REQUIRED] ${question}`);
    await queue.save();
    console.log(`Waiting for human decision: ${question}`);
    return;
  }
  const decision = args.slice(1).join(" ");
  if (!decision) {
    console.error("Usage: worqload decide <id> <decision>");
    console.error("       worqload decide <id> --human <question>");
    process.exit(1);
  }
  queue.transition(task.id, "deciding");
  queue.addLog(task.id, "decide", decision);
  await queue.save();
  console.log(`Decided: ${task.title}`);
}

export async function act(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  const note = args.slice(1).join(" ");
  if (note) {
    queue.addLog(task.id, "act", note);
  }
  queue.transition(task.id, "acting");
  await queue.save();
  console.log(`Acting: ${task.title}`);
}

export async function done(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  const note = args.slice(1).join(" ");
  if (note) {
    queue.addLog(task.id, "act", note);
  }
  queue.transition(task.id, "done");
  await queue.save();
  console.log(`Done: ${task.title}`);
}

export async function fail(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  const reason = args.slice(1).join(" ") || "No reason given";
  queue.addLog(task.id, "act", `[FAILED] ${reason}`);
  queue.transition(task.id, "failed");
  await queue.save();
  console.log(`Failed: ${task.title} - ${reason}`);
}

export async function retry(queue: TaskQueue, args: string[]) {
  const task = resolveTask(queue, args[0]);
  queue.addLog(task.id, "act", "[RETRY]");
  queue.transition(task.id, "pending");
  await queue.save();
  console.log(`Retrying: ${task.title}`);
}
