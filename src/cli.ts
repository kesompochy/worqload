#!/usr/bin/env bun
import type { TaskQueue as TaskQueueType } from "./queue";
import { init } from "./commands/init";
import { principle } from "./commands/principle";
import { add, list, show, context, next, clean, history, claim, unclaim } from "./commands/task";
import { observe, orient, decide, act, done, fail, retry } from "./commands/ooda";
import { spawn } from "./commands/spawn";
import { project } from "./commands/project";
import { feedback } from "./commands/feedback";
import { source } from "./commands/source";
import { heartbeat, serve } from "./commands/serve";

type CommandHandler = (queue: TaskQueueType, args: string[]) => Promise<void>;

const commands: Record<string, CommandHandler> = {
  init, principle,
  add, list, show, context, next, clean, history, claim, unclaim,
  observe, orient, decide, act, done, fail, retry,
  spawn,
  project,
  feedback,
  source,
  heartbeat, serve,
};

const { TaskQueue } = await import("./queue");
const queue = new TaskQueue();
await queue.load();

const [command, ...args] = process.argv.slice(2);

try {
  const handler = commands[command];
  if (handler) {
    await handler(queue, args);
  } else {
    printUsage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function printUsage() {
  console.log(`worqload - OODA task queue for AI agents

Principles:
  principle                      List principles with numbers
  principle <text>               Append a principle
  principle edit <N> <text>      Replace principle by number
  principle remove <N>           Remove principle by number

Tasks:
  add <title> [--priority N] [--by <creator>]  Add a new task
  list [status]                  List tasks (optionally filter by status)
  next                           Show next pending task
  clean                          Archive done/failed tasks
  history                        List archived tasks
  show <id>                      Show task details with logs
  context <id> [key] [value]     Show or set task context data
  claim <id> <owner>             Claim a task (lock for an agent)
  unclaim <id>                   Release a claimed task
  spawn <id> [owner]             Spawn a Claude agent to process a task
  init [path] [--name N]         Initialize worqload in a project
  serve [port]                   Start web UI (default: 3456)
  heartbeat [seconds]            Record loop heartbeat (default: 300s)

Projects:
  project                                List registered projects
  project register [path] [--name N]     Register a project (default: cwd)
  project remove <name>                  Remove a project

Feedback:
  feedback <message> [--from <sender>]  Send feedback
  feedback list                         List all feedback
  feedback ack <id>                     Acknowledge feedback
  feedback resolve <id>                 Mark feedback resolved

Sources (observation data):
  source                         List registered sources
  source add <name> <command>    Register a data source
  source remove <name>           Remove a data source
  source run                     Run all sources and show output

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
