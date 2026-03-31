#!/usr/bin/env bun
import type { TaskQueue as TaskQueueType } from "./queue";
import { EscalationError } from "./utils/errors";
import { init } from "./commands/init";
import { principle } from "./commands/principle";
import { add, list, show, context, next, clean, history, claim, unclaim } from "./commands/task";
import { observe, orient, decide, act, done, fail, retry } from "./commands/ooda";
import { spawn, spawnCleanup } from "./commands/spawn";
import { project } from "./commands/project";
import { feedback } from "./commands/feedback";
import { source } from "./commands/source";
import { heartbeat, serve, sleep, wake } from "./commands/serve";
import { report } from "./commands/report";
import { mission } from "./commands/mission";
import { resume } from "./commands/resume";
import { iterate } from "./commands/iterate";

type CommandHandler = (queue: TaskQueueType, args: string[]) => Promise<void>;

const commands: Record<string, CommandHandler> = {
  init, principle,
  add, list, show, context, next, clean, history, claim, unclaim,
  observe, orient, decide, act, done, fail, retry,
  spawn,
  "spawn-cleanup": spawnCleanup,
  project,
  feedback,
  source,
  report,
  mission,
  resume,
  iterate,
  heartbeat, serve, sleep, wake,
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
  if (error instanceof EscalationError) {
    console.error(error.message);
    process.exit(error.exitCode);
  }
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
  next                           Show next unassigned observing task
  clean                          Archive done/failed tasks
  history                        List archived tasks
  show <id>                      Show task details with logs
  context <id> [key] [value]     Show or set task context data
  claim <id> <owner>             Claim a task (lock for an agent)
  unclaim <id>                   Release a claimed task
  spawn <id> <command...>        Spawn a process to handle a task
  spawn-cleanup                  Clean up stuck spawned tasks
  init [path] [--name N]         Initialize worqload in a project
  resume                         Show session resume state
  serve [port]                   Start web UI (default: 3456)
  heartbeat [seconds]            Record loop heartbeat (default: 300s)
  sleep [minutes]                Pause the loop (show status if no arg)
  wake                           Cancel sleep and resume the loop

Projects:
  project                                List registered projects
  project register [path] [--name N]     Register a project (default: cwd)
  project remove <name>                  Remove a project

Feedback:
  feedback <message> [--from <sender>]  Send feedback
  feedback send <project> <message> [--from <sender>]  Send feedback to another project
  feedback list                         List all feedback
  feedback ack <id>                     Acknowledge feedback
  feedback resolve <id>                 Mark feedback resolved

Missions:
  mission                        List missions
  mission create <name> [--filter tags:a,b]  Create a mission
  mission list                   List missions with task counts
  mission assign <mid> <tid>     Assign a task to a mission
  mission run <mid>              Run mission agent as daemon (--foreground to block)
  mission complete <mid>         Complete a mission

Reports:
  report                         List reports
  report add <title> <content> [--by <creator>]  Create a report
  report show <id>               Show report content
  report status <id> <status>    Set status (unread/reading/read)
  report remove <id>             Delete a report

Sources (observation data):
  source                         List registered sources
  source add <name> <command>    Register a data source
  source remove <name>           Remove a data source
  source run                     Run all sources and show output

Iteration:
  iterate                        Run one managed OODA iteration as a tracked task

OODA phases:
  observe <id> [observations]    Start/record observations
  orient  <id> <analysis>        Record situation analysis
  decide  <id> <decision>        Record decision
  act     <id> [notes]           Mark as acting
  done    <id> [notes]           Mark as done
  fail    <id> [reason]          Mark as failed
  retry   <id>                   Retry a failed task`);
}
