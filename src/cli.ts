#!/usr/bin/env bun
import { serve } from "./commands/serve";
import { preview } from "./commands/preview";
import { init } from "./commands/init";
import { report } from "./commands/report";
import { escalate } from "./commands/escalate";
import { feedback } from "./commands/feedback";
import { sessionHost } from "./commands/session-host";

type Handler = (args: string[]) => Promise<void>;

const commands: Record<string, Handler> = {
  serve, preview, init, report, escalate, feedback,
  "session-host": sessionHost,
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
                                         changes hot-reload. Running sessions live in detached host
                                         processes and survive the restart.
  worqload preview [port] [--no-open] [--reset]
                                         Run THIS checkout against a throwaway scratch repo
                                         (~/.worqload-preview, or $WORQLOAD_PREVIEW_REPO) so a branch's
                                         UI can be tried before merging without touching the real
                                         .worqload/ state; --reset recreates the scratch repo from
                                         preview-seed/. Run via \`bun run preview\` from inside the
                                         worktree under test, not a \`bun link\`ed \`worqload\`.
  worqload init [path]                   Initialize .worqload/

Agent-side (called by claude inside a session):
  worqload report submit --slug <slug>   Submit a report (body via stdin)
  worqload escalate submit --slug <slug> Submit an escalation (body via stdin)
  worqload escalate command --command <cmd>
                                         Ask the human to approve running a command (optional reason
                                         via stdin); on approval the server runs it and feeds back
                                         its stdout/stderr. Pauses your turn like an escalation.
  worqload feedback fetch                Drain pending feedback inbox
  worqload feedback fetch <filename>     Fetch a specific feedback message by filename
  worqload feedback list                 List all feedback (inbox + read) with previews`);
}
