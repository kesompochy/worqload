import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { runHost } from "./commands/session-host";
import type { Event } from "./event-log";
import { createSession, loadSessionMeta, saveSessionMeta } from "./session";
import { connectToHost } from "./session-host-client";
import { cleanupAll, makeTmpDir } from "./test-helpers";

afterEach(cleanupAll);

const MOCK = join(import.meta.dir, "__fixtures__", "mock-claude.ts");

interface InProcessHost {
  sessionsDir: string;
  socketPath: string;
  sessionId: string;
  hostExit: Promise<number>;
}

async function bootHost(mode: "hang" | "echo" | "init" | "crash"): Promise<InProcessHost> {
  const sessionsDir = makeTmpDir("client-host");
  const worktree = makeTmpDir("client-host-wt");
  const meta = createSession({
    prompt: "do thing",
    baseBranch: "main",
    baseCommit: "abc123",
    worktreePath: worktree,
  });
  await saveSessionMeta(meta, sessionsDir);
  const socketPath = join(makeTmpDir("client-host-sock"), `${meta.id.slice(0, 8)}.sock`);

  const hostExit = runHost({
    sessionId: meta.id,
    sessionsDir,
    socketPath,
    spawnCommand: ["bun", MOCK, mode],
  });
  return { sessionsDir, socketPath, sessionId: meta.id, hostExit };
}

test("connectToHost retries until the socket appears, then replays past events", async () => {
  const { socketPath, hostExit } = await bootHost("hang");
  const events: Event[] = [];
  const client = await connectToHost({
    socketPath,
    sinceSeq: 0,
    onEvent: (ev) => {
      events.push(ev);
    },
  });
  await client.replayCompleted;
  expect(events.some((e) => e.kind === "session_started")).toBe(true);

  await client.kill("SIGTERM");
  await client.exited;
  await hostExit;
});

test("connectToHost.send pushes a user message and the host echoes it back as an event", async () => {
  const { socketPath, hostExit } = await bootHost("echo");
  const events: Event[] = [];
  const client = await connectToHost({
    socketPath,
    sinceSeq: 0,
    onEvent: (ev) => {
      events.push(ev);
    },
  });
  await client.replayCompleted;
  events.length = 0; // clear replay noise

  await client.send("ping-from-client");

  // Wait for the echo
  for (let i = 0; i < 100; i++) {
    if (
      events.some(
        (e) =>
          e.kind === "claude_assistant_message" &&
          JSON.stringify(e.payload).includes("ping-from-client"),
      )
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(
    events.some(
      (e) =>
        e.kind === "claude_assistant_message" &&
        JSON.stringify(e.payload).includes("ping-from-client"),
    ),
  ).toBe(true);

  await client.kill("SIGTERM");
  await client.exited;
  await hostExit;
});

test("connectToHost.exited resolves and meta becomes crashed when claude exits non-zero", async () => {
  const { sessionsDir, sessionId, socketPath, hostExit } = await bootHost("crash");
  const client = await connectToHost({ socketPath, sinceSeq: 0 });
  // crash exits very fast; replayCompleted may race with exit. Either order is ok.
  await Promise.race([client.replayCompleted.catch(() => {}), client.exited]);
  await client.exited;
  await hostExit;
  const meta = await loadSessionMeta(sessionId, sessionsDir);
  expect(meta?.status).toBe("crashed");
});

test("connectToHost reports onDisconnect when the host process goes away", async () => {
  const { socketPath, hostExit } = await bootHost("hang");
  let disconnected = false;
  const client = await connectToHost({
    socketPath,
    sinceSeq: 0,
    onDisconnect: () => {
      disconnected = true;
    },
  });
  await client.replayCompleted;

  await client.kill("SIGTERM");
  await client.exited;
  await hostExit;

  // small grace for the close handler
  await new Promise((r) => setTimeout(r, 50));
  expect(disconnected).toBe(true);
});
