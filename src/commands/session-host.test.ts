import { afterEach, expect, test } from "bun:test";
import type { Socket } from "bun";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "../event-log";
import { createSession, hostLogPath, loadSessionMeta, saveSessionMeta } from "../session";
import { encodeMessage, type HostToServeMessage, parseLineDelimited } from "../session-host-protocol";
import { cleanupAll, makeTmpDir } from "../test-helpers";
import { runHost } from "./session-host";

afterEach(cleanupAll);

const MOCK = join(import.meta.dir, "..", "__fixtures__", "mock-claude.ts");

interface HostFixture {
  sessionsDir: string;
  socketPath: string;
  sessionId: string;
  hostExit: Promise<number>;
}

async function setupHost(
  mockMode: "hang" | "echo" | "init" | "crash" | "env",
  agentEndpoint = "http://127.0.0.1:0",
  opts: { resume?: boolean; logFile?: string } = {},
): Promise<HostFixture> {
  const sessionsDir = makeTmpDir("host-test");
  const worktree = makeTmpDir("host-test-wt");
  const meta = createSession({
    prompt: "do thing",
    baseBranch: "main",
    baseCommit: "abc123",
    worktreePath: worktree,
    branchName: "host-test",
  });
  await saveSessionMeta(meta, sessionsDir);
  // host.log lives at sessionsDir/<id>/, which saveSessionMeta has just created.
  mkdirSync(join(sessionsDir, meta.id), { recursive: true });
  const socketPath = join(makeTmpDir("host-test-sock"), `${meta.id.slice(0, 8)}.sock`);

  const hostExit = runHost({
    sessionId: meta.id,
    sessionsDir,
    socketPath,
    agentEndpoint,
    spawnCommand: ["bun", MOCK, mockMode],
    ...(opts.resume && { resume: true }),
    ...(opts.logFile !== undefined && { logFile: opts.logFile }),
  });
  return { sessionsDir, socketPath, sessionId: meta.id, hostExit };
}

interface TestClient {
  send(msg: object): void;
  next(predicate: (m: HostToServeMessage) => boolean, timeoutMs?: number): Promise<HostToServeMessage>;
  collect(): HostToServeMessage[];
  end(): void;
}

async function connectClient(socketPath: string): Promise<TestClient> {
  const inbox: HostToServeMessage[] = [];
  const waiters: Array<(msg: HostToServeMessage) => boolean> = [];
  let bufState = "";
  let resolveSocket!: (s: Socket<undefined>) => void;
  const socketReady = new Promise<Socket<undefined>>((r) => {
    resolveSocket = r;
  });

  let socket: Socket<undefined> | null = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      socket = await Bun.connect<undefined>({
        unix: socketPath,
        socket: {
          open(s) {
            resolveSocket(s);
          },
          data(_s, chunk) {
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            const { messages, buffer } = parseLineDelimited<HostToServeMessage>(text, bufState);
            bufState = buffer;
            for (const m of messages) {
              inbox.push(m);
              for (let i = waiters.length - 1; i >= 0; i--) {
                if (waiters[i](m)) {
                  waiters.splice(i, 1);
                }
              }
            }
          },
          close() {},
        },
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  if (!socket) throw new Error(`failed to connect to host socket at ${socketPath}`);
  await socketReady;
  return {
    send(msg) {
      socket.write(encodeMessage(msg as never));
    },
    async next(predicate, timeoutMs = 2000) {
      const existing = inbox.find(predicate);
      if (existing) return existing;
      return new Promise<HostToServeMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
        waiters.push((m) => {
          if (!predicate(m)) return false;
          clearTimeout(timer);
          resolve(m);
          return true;
        });
      });
    },
    collect() {
      return inbox.slice();
    },
    end() {
      socket.end();
    },
  };
}

test("runHost writes session_started and updates meta with hostPid/hostSocketPath", async () => {
  const { sessionsDir, sessionId, hostExit, socketPath } = await setupHost("hang");
  const client = await connectClient(socketPath);
  client.send({ type: "hello", sinceSeq: 0 });
  const replayDone = await client.next((m) => m.type === "replay_done");
  expect(replayDone.type).toBe("replay_done");

  const meta = await loadSessionMeta(sessionId, sessionsDir);
  expect(meta?.hostPid).toBe(process.pid);
  expect(meta?.hostSocketPath).toBe(socketPath);
  expect(meta?.status).toBe("running");

  const events = await readEvents(sessionId, 1, sessionsDir);
  const kinds = events.map((e) => e.kind);
  expect(kinds).toContain("session_started");

  client.send({ type: "kill", signal: "SIGTERM" });
  await client.next((m) => m.type === "exited");
  await hostExit;
});

test("runHost gives claude WORQLOAD_SESSION_ID and WORQLOAD_ENDPOINT", async () => {
  const { sessionId, hostExit, socketPath } = await setupHost("env", "http://127.0.0.1:34567");
  const client = await connectClient(socketPath);
  client.send({ type: "hello", sinceSeq: 0 });
  // The env probe rides on a claude system line; the driver normalizes the
  // payload and keeps the raw line under `wire`, where its fields live.
  const envEvent = await client.next(
    (m) =>
      m.type === "event" &&
      (m.event.payload as { wire?: { subtype?: string } })?.wire?.subtype === "worqload_env",
  );
  if (envEvent.type !== "event") throw new Error("unreachable");
  const wire = (envEvent.event.payload as { wire: { sessionId: string; endpoint: string } }).wire;
  expect(wire.sessionId).toBe(sessionId);
  expect(wire.endpoint).toBe("http://127.0.0.1:34567");

  client.send({ type: "kill", signal: "SIGTERM" });
  await hostExit;
});

test("runHost forwards send_user to claude (echo mode round-trips a reply)", async () => {
  const { sessionsDir, sessionId, hostExit, socketPath } = await setupHost("echo");
  const client = await connectClient(socketPath);
  client.send({ type: "hello", sinceSeq: 0 });
  await client.next((m) => m.type === "replay_done");

  client.send({ type: "send_user", text: "ping" });
  const eventMsg = await client.next(
    (m) => m.type === "event" && m.event.kind === "claude_assistant_message",
  );
  expect(eventMsg.type).toBe("event");

  client.send({ type: "kill", signal: "SIGTERM" });
  await client.next((m) => m.type === "exited").catch(() => {});
  await hostExit;

  const events = await readEvents(sessionId, 1, sessionsDir);
  expect(events.some((e) => e.kind === "claude_assistant_message")).toBe(true);
});

test("runHost replays past events on hello with sinceSeq=0 and then signals replay_done", async () => {
  const { sessionsDir: _sessionsDir, hostExit, socketPath } = await setupHost("hang");
  const client = await connectClient(socketPath);
  client.send({ type: "hello", sinceSeq: 0 });
  // session_started should be replayed
  const sessionStarted = await client.next(
    (m) => m.type === "event" && m.event.kind === "session_started",
  );
  expect(sessionStarted.type).toBe("event");
  const replayDone = await client.next((m) => m.type === "replay_done");
  if (replayDone.type !== "replay_done") throw new Error("unexpected");
  expect(replayDone.lastSeq).toBeGreaterThanOrEqual(1);

  client.send({ type: "kill", signal: "SIGTERM" });
  await hostExit;
});

test("runHost marks meta as stopped after claude exits cleanly", async () => {
  const { sessionsDir, sessionId, hostExit } = await setupHost("init");
  await hostExit;

  const meta = await loadSessionMeta(sessionId, sessionsDir);
  expect(meta?.status).toBe("stopped");
});

test("runHost survives a client disconnect and accepts a new client that receives live events", async () => {
  const { hostExit, socketPath } = await setupHost("echo");
  // first client: bootstrap, drive a message, then disconnect
  const first = await connectClient(socketPath);
  first.send({ type: "hello", sinceSeq: 0 });
  await first.next((m) => m.type === "replay_done");
  first.send({ type: "send_user", text: "first" });
  const firstEcho = await first.next(
    (m) =>
      m.type === "event" &&
      m.event.kind === "claude_assistant_message" &&
      JSON.stringify(m.event.payload).includes("first"),
  );
  if (firstEcho.type !== "event") throw new Error("unreachable");
  const firstSeq = firstEcho.event.seq;
  first.end();

  // brief pause for host to observe disconnect
  await new Promise((r) => setTimeout(r, 50));

  // second client should be able to drive new traffic
  const second = await connectClient(socketPath);
  second.send({ type: "hello", sinceSeq: firstSeq });
  await second.next((m) => m.type === "replay_done");

  second.send({ type: "send_user", text: "after-reconnect" });
  const second_event = await second.next(
    (m) =>
      m.type === "event" &&
      m.event.kind === "claude_assistant_message" &&
      JSON.stringify(m.event.payload).includes("after-reconnect"),
  );
  expect(second_event.type).toBe("event");

  second.send({ type: "kill", signal: "SIGTERM" });
  await hostExit;
});

test("runHost marks meta as crashed on claude non-zero exit", async () => {
  const { sessionsDir, sessionId, hostExit } = await setupHost("crash");
  await hostExit;

  const meta = await loadSessionMeta(sessionId, sessionsDir);
  expect(meta?.status).toBe("crashed");
});

test("runHost appends host_started, send_user_received and stdin_write to logFile", async () => {
  const logFile = join(makeTmpDir("host-test-log"), "host.log");
  const { hostExit, socketPath } = await setupHost("echo", undefined, { logFile });
  const client = await connectClient(socketPath);
  client.send({ type: "hello", sinceSeq: 0 });
  await client.next((m) => m.type === "replay_done");

  const wakeText = "[wake] check feedback inbox";
  client.send({ type: "send_user", text: wakeText });
  await client.next(
    (m) =>
      m.type === "event" &&
      m.event.kind === "claude_assistant_message" &&
      JSON.stringify(m.event.payload).includes(wakeText),
  );

  client.send({ type: "kill", signal: "SIGTERM" });
  await client.next((m) => m.type === "exited").catch(() => {});
  await hostExit;

  const entries = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  expect(entries.some((e) => e.event === "host_started")).toBe(true);

  const sendUser = entries.find((e) => e.event === "send_user_received");
  expect(sendUser).toBeDefined();
  expect(sendUser?.preview).toBe(wakeText);
  expect(sendUser?.textLen).toBe(wakeText.length);

  // At least one stdin_write entry must come from the wake (source !== "bootstrap").
  const writes = entries.filter((e) => e.event === "stdin_write");
  expect(writes.length).toBeGreaterThanOrEqual(2); // bootstrap + wake
  expect(writes.every((e) => e.ok === true)).toBe(true);
});

test("runHost uses hostLogPath under the sessions dir for its diagnostic log", async () => {
  const sessionsDir = makeTmpDir("host-test");
  const worktree = makeTmpDir("host-test-wt");
  const meta = createSession({
    prompt: "do thing",
    baseBranch: "main",
    baseCommit: "abc123",
    worktreePath: worktree,
    branchName: "host-test",
  });
  await saveSessionMeta(meta, sessionsDir);
  mkdirSync(join(sessionsDir, meta.id), { recursive: true });
  const socketPath = join(makeTmpDir("host-test-sock"), `${meta.id.slice(0, 8)}.sock`);
  const logFile = hostLogPath(sessionsDir, meta.id);

  const hostExit = runHost({
    sessionId: meta.id,
    sessionsDir,
    socketPath,
    agentEndpoint: "http://127.0.0.1:0",
    spawnCommand: ["bun", MOCK, "hang"],
    logFile,
  });

  const client = await connectClient(socketPath);
  client.send({ type: "hello", sinceSeq: 0 });
  await client.next((m) => m.type === "replay_done");

  client.send({ type: "kill", signal: "SIGTERM" });
  await hostExit;

  const entries = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(entries.some((e) => e.event === "host_started" && e.sessionId === meta.id)).toBe(true);
  expect(entries.some((e) => e.event === "claude_exited")).toBe(true);
});

test("runHost in resume mode emits session_resumed, not session_started", async () => {
  const { sessionsDir, sessionId, hostExit, socketPath } = await setupHost("echo", undefined, { resume: true });
  const client = await connectClient(socketPath);
  client.send({ type: "hello", sinceSeq: 0 });
  await client.next((m) => m.type === "replay_done");

  // Let the resumed host drive claude far enough to produce one assistant
  // message before tearing it down, so the event sequence is fully recorded.
  await client.next(
    (m) => m.type === "event" && m.event.kind === "claude_assistant_message",
  );

  client.send({ type: "kill", signal: "SIGTERM" });
  await client.next((m) => m.type === "exited").catch(() => {});
  await hostExit;

  const events = await readEvents(sessionId, 1, sessionsDir);
  const kinds = events.map((e) => e.kind);
  expect(kinds).toContain("session_resumed");
  expect(kinds).not.toContain("session_started");
});
