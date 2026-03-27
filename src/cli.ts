import { createTask } from "./task";
import type { TaskStatus } from "./task";
import { TaskQueue } from "./queue";
import { loadPrinciples, savePrinciples } from "./principles";

const queue = new TaskQueue();
await queue.load();

const [command, ...args] = process.argv.slice(2);

try {
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
    let priority = 0;
    const filtered: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--priority" && i + 1 < args.length) {
        priority = Number(args[i + 1]);
        if (!Number.isFinite(priority)) {
          console.error("Priority must be a number.");
          process.exit(1);
        }
        i++;
      } else {
        filtered.push(args[i]);
      }
    }
    const title = filtered.join(" ").trim();
    if (!title) {
      console.error("Usage: worqload add <title> [--priority N]");
      process.exit(1);
    }
    const task = createTask(title, {}, priority);
    queue.enqueue(task);
    await queue.save();
    console.log(`Added: ${task.title} (${task.id.slice(0, 8)}) [priority: ${priority}]`);
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
      const priorityLabel = task.priority !== 0 ? ` p:${task.priority}` : "";
      console.log(`[${task.status.padEnd(13)}] ${task.title} (${task.id.slice(0, 8)})${priorityLabel}`);
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
    const note = args.slice(1).join(" ");
    queue.transition(task.id, "observing");
    if (note) {
      queue.addLog(task.id, "observe", note);
    }
    await queue.save();
    console.log(note ? `Observed: ${task.title}` : `Observing: ${task.title}`);
    break;
  }

  case "orient": {
    const task = resolveTask(args[0]);
    const note = args.slice(1).join(" ");
    if (!note) {
      console.error("Usage: worqload orient <id> <analysis>");
      process.exit(1);
    }
    queue.transition(task.id, "orienting");
    queue.addLog(task.id, "orient", note);
    await queue.save();
    console.log(`Oriented: ${task.title}`);
    break;
  }

  case "decide": {
    const task = resolveTask(args[0]);
    if (args[1] === "--human") {
      const question = args.slice(2).join(" ") || "Decision required";
      queue.transition(task.id, "waiting_human");
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
    queue.transition(task.id, "deciding");
    queue.addLog(task.id, "decide", decision);
    await queue.save();
    console.log(`Decided: ${task.title}`);
    break;
  }

  case "act": {
    const task = resolveTask(args[0]);
    const note = args.slice(1).join(" ");
    if (note) {
      queue.addLog(task.id, "act", note);
    }
    queue.transition(task.id, "acting");
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
    queue.transition(task.id, "done");
    await queue.save();
    console.log(`Done: ${task.title}`);
    break;
  }

  case "fail": {
    const task = resolveTask(args[0]);
    const reason = args.slice(1).join(" ") || "No reason given";
    queue.addLog(task.id, "act", `[FAILED] ${reason}`);
    queue.transition(task.id, "failed");
    await queue.save();
    console.log(`Failed: ${task.title} - ${reason}`);
    break;
  }

  case "retry": {
    const task = resolveTask(args[0]);
    queue.addLog(task.id, "act", "[RETRY]");
    queue.transition(task.id, "pending");
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
    const archived = await queue.archive(terminated.map(t => t.id));
    console.log(`Archived ${archived.length} task(s).`);
    break;
  }

  case "history": {
    const archived = await queue.history();
    if (archived.length === 0) {
      console.log("No archived tasks.");
      break;
    }
    for (const task of archived) {
      console.log(`[${task.status.padEnd(13)}] ${task.title} (${task.id.slice(0, 8)})`);
    }
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

  case "serve": {
    const port = Number(args[0]) || 3456;
    const { startServer } = await import("./server");
    startServer(port);
    break;
  }

  default:
    console.log(`worqload - OODA task queue for AI agents

Principles:
  principle                      List principles with numbers
  principle <text>               Append a principle
  principle remove <N>           Remove principle by number

Tasks:
  add <title> [--priority N]     Add a new task (higher N = higher priority)
  list [status]                  List tasks (optionally filter by status)
  next                           Show next pending task
  clean                          Archive done/failed tasks
  history                        List archived tasks
  show <id>                      Show task details with logs
  context <id> [key] [value]     Show or set task context data
  serve [port]                   Start web UI (default: 3456)

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
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
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

