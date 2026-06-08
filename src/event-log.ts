import { withLock } from "./lock";
import { DEFAULT_SESSIONS_DIR } from "./session";

export type EventKind =
  | "session_started"
  | "session_resumed"
  | "claude_assistant_message"
  | "claude_tool_use"
  | "claude_tool_result"
  | "claude_system"
  // Normalized "the agent finished responding to a user message" signal. Each
  // SessionDriver emits this from its own wire-specific terminator (pipe: the
  // stream-json result line; tmux: the transcript assistant end_turn line;
  // codex: turn.completed/turn.failed) so consumers react to one domain event
  // instead of sniffing per-driver shapes. Carries no payload; the preceding
  // agent event holds the detail. Drives the report-less auto-nudge.
  | "turn_completed"
  | "report_submitted"
  | "report_read"
  | "report_unread"
  | "report_deleted"
  | "escalation_requested"
  | "escalation_resolved"
  | "feedback_received"
  | "feedback_fetched"
  | "action_invoked"
  | "session_stopped"
  | "session_crashed"
  // Marker the wake watchdog emits before auto-resuming a session whose host
  // never echoed our wake. The host then writes its usual session_resumed.
  | "session_auto_resumed";

export interface Event {
  seq: number;
  kind: EventKind;
  timestamp: string;
  payload: unknown;
}

function eventsPath(sessionsDir: string, sessionId: string): string {
  return `${sessionsDir}/${sessionId}/events.ndjson`;
}

async function readAllRaw(path: string): Promise<Event[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  if (text.trim() === "") return [];
  const events: Event[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as Event);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

export async function appendEvent(
  sessionId: string,
  event: Omit<Event, "seq" | "timestamp">,
  sessionsDir: string = DEFAULT_SESSIONS_DIR,
): Promise<Event> {
  const path = eventsPath(sessionsDir, sessionId);
  return withLock(path, async () => {
    const existing = await readAllRaw(path);
    const lastSeq = existing.length > 0 ? existing[existing.length - 1].seq : 0;
    const full: Event = {
      seq: lastSeq + 1,
      kind: event.kind,
      timestamp: new Date().toISOString(),
      payload: event.payload,
    };
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    const line = `${JSON.stringify(full)}\n`;
    const file = Bun.file(path);
    const previous = (await file.exists()) ? await file.text() : "";
    await Bun.write(path, previous + line);
    return full;
  });
}

export async function readEvents(
  sessionId: string,
  fromSeq: number = 1,
  sessionsDir: string = DEFAULT_SESSIONS_DIR,
): Promise<Event[]> {
  const path = eventsPath(sessionsDir, sessionId);
  const all = await readAllRaw(path);
  return all.filter(e => e.seq >= fromSeq);
}
