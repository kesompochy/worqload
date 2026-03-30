import { exitWithError } from "../utils/errors";
import type { TaskQueue } from "../queue";
import { HUMAN_REQUIRED_PREFIX } from "../task";
import { resolveTask } from "./resolve";
import { runOnDoneHooks } from "../hooks";

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
    exitWithError("Usage: worqload orient <id> <analysis>");
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
    queue.addLog(task.id, "decide", `${HUMAN_REQUIRED_PREFIX}${question}`);
    await queue.save();
    console.log(`Waiting for human decision: ${question}`);
    return;
  }
  const decision = args.slice(1).join(" ");
  if (!decision) {
    console.error("Usage: worqload decide <id> <decision>");
    exitWithError("       worqload decide <id> --human <question>");
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
  await runOnDoneHooks(task.id, task.title);
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
  queue.transition(task.id, "observing");
  await queue.save();
  console.log(`Retrying: ${task.title}`);
}
