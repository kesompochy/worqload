#!/usr/bin/env bun
import { serve } from "./commands/serve";
import { init } from "./commands/init";
import { report } from "./commands/report";
import { escalate } from "./commands/escalate";
import { feedback } from "./commands/feedback";

type Handler = (args: string[]) => Promise<void>;

const commands: Record<string, Handler> = {
  serve, init, report, escalate, feedback,
};

const [command, ...args] = process.argv.slice(2);

try {
  const handler = command ? commands[command] : undefined;
  if (handler) {
    await handler(args);
  } else {
    printUsage();
    process.exit(command ? 2 : 0);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

function printUsage() {
  console.log(`worqload — asynchronous claude session viewer

Usage:
  worqload serve [port] [--no-open] [--watch]
                                         Start HTTP/WS server (default port 3456; auto-shifts if busy;
                                         opens browser unless --no-open).
                                         --watch reruns the server under \`bun --watch\` so source
                                         changes hot-reload (running sessions get orphaned: dev use).
  worqload init [path]                   Initialize .worqload/

Agent-side (called by claude inside a session):
  worqload report submit --slug <slug>   Submit a report (body via stdin)
  worqload escalate submit --slug <slug> Submit an escalation (body via stdin)
  worqload feedback fetch                Drain pending feedback inbox`);
}
