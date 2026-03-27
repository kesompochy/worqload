import { createTask } from "./task";
import type { TaskStatus } from "./task";
import { TaskQueue } from "./queue";
import { loadPrinciples, savePrinciples } from "./principles";

const queue = new TaskQueue();
await queue.load();

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "principle": {
    if (args[0] === "remove") {
      const index = Number(args[1]);
      const content = await loadPrinciples();
      const lines = content.split("\n").filter(l => l.startsWith("- "));
      if (!Number.isInteger(index) || index < 1 || index > lines.length) {
        console.error(`Invalid index: ${args[1]}. Valid range: 1-${lines.length}`);
        process.exit(1);
      }
      lines.splice(index - 1, 1);
      const updated = lines.length > 0 ? `# Principles\n\n${lines.join("\n")}` : "";
      await savePrinciples(updated);
      console.log(`Principle removed (#${index}).`);
      break;
    }
    if (args.length === 0) {
      const content = await loadPrinciples();
      if (!content) {
        console.log("No principles defined.");
        console.log("Usage: worqload principle <text to append>");
      } else {
        const lines = content.split("\n").filter(l => l.startsWith("- "));
        console.log("# Principles\n");
        for (let i = 0; i < lines.length; i++) {
          console.log(`${i + 1}. ${lines[i].slice(2)}`);
        }
      }
      break;
    }
    const current = await loadPrinciples();
    const newLine = args.join(" ");
    const updated = current ? `${current}\n- ${newLine}` : `# Principles\n\n- ${newLine}`;
    await savePrinciples(updated);
    console.log(`Principle added: ${newLine}`);
    break;
  }

  case "add": {
    const title = args.join(" ").trim();
    if (!title) {
      console.error("Usage: worqload add <title>");
      process.exit(1);
    }
    const task = createTask(title);
    queue.enqueue(task);
    await queue.save();
    console.log(`Added: ${task.title} (${task.id.slice(0, 8)})`);
    break;
  }

  case "list": {
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
      break;
    }
    for (const task of tasks) {
      console.log(`[${task.status.padEnd(13)}] ${task.title} (${task.id.slice(0, 8)})`);
    }
    break;
  }

  case "show": {
    const task = resolveTask(args[0]);
    console.log(JSON.stringify(task, null, 2));
    break;
  }

  case "context": {
    const task = resolveTask(args[0]);
    const key = args[1];
    if (!key) {
      console.log(JSON.stringify(task.context, null, 2));
      break;
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
    break;
  }

  case "observe": {
    const task = resolveTask(args[0]);
    requireStatus(task, ["pending", "observing"]);
    const note = args.slice(1).join(" ");
    if (!note) {
      queue.update(task.id, { status: "observing" });
      await queue.save();
      console.log(`Observing: ${task.title}`);
      break;
    }
    queue.update(task.id, { status: "observing" });
    queue.addLog(task.id, "observe", note);
    await queue.save();
    console.log(`Observed: ${task.title}`);
    break;
  }

  case "orient": {
    const task = resolveTask(args[0]);
    requireStatus(task, ["observing", "orienting"]);
    const note = args.slice(1).join(" ");
    if (!note) {
      console.error("Usage: worqload orient <id> <analysis>");
      process.exit(1);
    }
    queue.update(task.id, { status: "orienting" });
    queue.addLog(task.id, "orient", note);
    await queue.save();
    console.log(`Oriented: ${task.title}`);
    break;
  }

  case "decide": {
    const task = resolveTask(args[0]);
    requireStatus(task, ["orienting", "deciding", "waiting_human"]);
    if (args[1] === "--human") {
      const question = args.slice(2).join(" ") || "Decision required";
      queue.update(task.id, { status: "waiting_human" });
      queue.addLog(task.id, "decide", `[HUMAN REQUIRED] ${question}`);
      await queue.save();
      console.log(`Waiting for human decision: ${question}`);
      break;
    }
    const decision = args.slice(1).join(" ");
    if (!decision) {
      console.error("Usage: worqload decide <id> <decision>");
      console.error("       worqload decide <id> --human <question>");
      process.exit(1);
    }
    queue.update(task.id, { status: "deciding" });
    queue.addLog(task.id, "decide", decision);
    await queue.save();
    console.log(`Decided: ${task.title}`);
    break;
  }

  case "act": {
    const task = resolveTask(args[0]);
    requireStatus(task, ["deciding", "acting"]);
    const note = args.slice(1).join(" ");
    if (note) {
      queue.addLog(task.id, "act", note);
    }
    queue.update(task.id, { status: "acting" });
    await queue.save();
    console.log(`Acting: ${task.title}`);
    break;
  }

  case "done": {
    const task = resolveTask(args[0]);
    const note = args.slice(1).join(" ");
    if (note) {
      queue.addLog(task.id, "act", note);
    }
    queue.update(task.id, { status: "done" });
    await queue.save();
    console.log(`Done: ${task.title}`);
    break;
  }

  case "fail": {
    const task = resolveTask(args[0]);
    const reason = args.slice(1).join(" ") || "No reason given";
    queue.addLog(task.id, "act", `[FAILED] ${reason}`);
    queue.update(task.id, { status: "failed" });
    await queue.save();
    console.log(`Failed: ${task.title} - ${reason}`);
    break;
  }

  case "retry": {
    const task = resolveTask(args[0]);
    requireStatus(task, ["failed"]);
    queue.addLog(task.id, "act", "[RETRY]");
    queue.update(task.id, { status: "pending" });
    await queue.save();
    console.log(`Retrying: ${task.title}`);
    break;
  }

  case "clean": {
    const terminated = queue.list().filter(t => t.status === "done" || t.status === "failed");
    if (terminated.length === 0) {
      console.log("No done/failed tasks to clean.");
      break;
    }
    for (const task of terminated) {
      queue.remove(task.id);
    }
    await queue.save();
    console.log(`Cleaned ${terminated.length} task(s).`);
    break;
  }

  case "next": {
    const task = queue.dequeue();
    if (!task) {
      console.log("No pending tasks.");
      break;
    }
    console.log(JSON.stringify(task, null, 2));
    break;
  }

  default:
    console.log(`worqload - OODA task queue for AI agents

Principles:
  principle                      List principles with numbers
  principle <text>               Append a principle
  principle remove <N>           Remove principle by number

Tasks:
  add <title>                    Add a new task
  list [status]                  List tasks (optionally filter by status)
  next                           Show next pending task
  clean                          Remove done/failed tasks
  show <id>                      Show task details with logs
  context <id> [key] [value]     Show or set task context data

OODA phases:
  observe <id> [observations]    Start/record observations
  orient  <id> <analysis>        Record situation analysis
  decide  <id> <decision>        Record decision
  decide  <id> --human <question>  Escalate to human
  act     <id> [notes]           Mark as acting
  done    <id> [notes]           Mark as done
  fail    <id> [reason]          Mark as failed
  retry   <id>                   Retry a failed task`);
}

function resolveTask(idPrefix: string | undefined) {
  if (!idPrefix) {
    console.error("Task ID required.");
    process.exit(1);
  }
  const task = queue.findById(idPrefix);
  if (!task) {
    console.error(`Task not found: ${idPrefix}`);
    process.exit(1);
  }
  return task;
}

function requireStatus(task: { status: TaskStatus; title: string }, allowed: TaskStatus[]) {
  if (!allowed.includes(task.status)) {
    console.error(`Task "${task.title}" is ${task.status}, expected: ${allowed.join(" or ")}`);
    process.exit(1);
  }
}
