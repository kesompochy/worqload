import { afterEach, expect, test } from "bun:test";
import type { Socket } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSession, saveSessionMeta } from "../session";
import {
  encodeMessage,
  type HostToServeMessage,
  parseLineDelimited,
} from "../session-host-protocol";
import type {
  SessionDriver,
  SessionDriverFactory,
  SessionDriverLaunchOptions,
} from "../session-driver";
import { cleanupAll, makeTmpDir } from "../test-helpers";
import { runHost } from "./session-host";

afterEach(cleanupAll);

interface SentMessage {
  text: string;
  source: "bootstrap" | "send_user";
}

interface FakeDriverHandle {
  factory: SessionDriverFactory;
  sent: SentMessage[];
  killSignals: Array<"SIGTERM" | "SIGKILL">;
  // Resolves with the launch options the factory was invoked with, after the
  // factory runs. Lets the test assert on cwd/env/spawnCommand without racing.
  launched: Promise<SessionDriverLaunchOptions>;
  // Call to make the driver report exit (so runHost can finalize).
  exit(code: number): void;
}

function makeFakeDriver(): FakeDriverHandle {
  const sent: SentMessage[] = [];
  const killSignals: Array<"SIGTERM" | "SIGKILL"> = [];
  let exitResolve!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    exitResolve = r;
  });

  let launchedResolve!: (opts: SessionDriverLaunchOptions) => void;
  const launched = new Promise<SessionDriverLaunchOptions>((r) => {
    launchedResolve = r;
  });

  const factory: SessionDriverFactory = async (opts) => {
    launchedResolve(opts);
    const driver: SessionDriver = {
      async sendUserMessage(text, source) {
        sent.push({ text, source });
      },
      kill(signal) {
        killSignals.push(signal);
      },
      exited,
    };
    return driver;
  };

  return {
    factory,
    sent,
    killSignals,
    launched,
    exit(code) {
      exitResolve(code);
    },
  };
}

interface TestClient {
  send(msg: object): void;
  next(predicate: (m: HostToServeMessage) => boolean, timeoutMs?: number): Promise<HostToServeMessage>;
  end(): void;
}

async function connectClient(socketPath: string): Promise<TestClient> {
  const inbox: HostToServeMessage[] = [];
  const waiters: Array<(msg: HostToServeMessage) => boolean> = [];
  let bufState = "";
  let socket: Socket<undefined> | null = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      socket = await Bun.connect<undefined>({
        unix: socketPath,
        socket: {
          open() {},
          data(_s, chunk) {
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            const { messages, buffer } = parseLineDelimited<HostToServeMessage>(text, bufState);
            bufState = buffer;
            for (const m of messages) {
              inbox.push(m);
              for (let i = waiters.length - 1; i >= 0; i--) {
                if (waiters[i](m)) waiters.splice(i, 1);
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

  return {
    send(msg) {
      socket.write(encodeMessage(msg as never));
    },
    async next(predicate, timeoutMs = 2000) {
      const existing = inbox.find(predicate);
      if (existing) return existing;
      return new Promise<HostToServeMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
        waiters.push((m) => {
          if (!predicate(m)) return false;
          clearTimeout(timer);
          resolve(m);
          return true;
        });
      });
    },
    end() {
      socket.end();
    },
  };
}

test("runHost routes bootstrap, send_user and kill through an injected SessionDriver instead of spawning a process", async () => {
  const sessionsDir = makeTmpDir("driver-test");
  const worktree = makeTmpDir("driver-test-wt");
  const meta = createSession({
    prompt: "do thing",
    baseBranch: "main",
    baseCommit: "abc123",
    worktreePath: worktree,
    branchName: "driver-test",
  });
  await saveSessionMeta(meta, sessionsDir);
  mkdirSync(join(sessionsDir, meta.id), { recursive: true });
  const socketPath = join(makeTmpDir("driver-test-sock"), `${meta.id.slice(0, 8)}.sock`);

  const fake = makeFakeDriver();

  const hostExit = runHost({
    sessionId: meta.id,
    sessionsDir,
    socketPath,
    agentEndpoint: "http://127.0.0.1:0",
    // This argv must NOT be invoked: the fake driver replaces the real spawn.
    // We still pass it so we can assert the driver received it verbatim.
    spawnCommand: ["this-should-not-be-executed", "--flag"],
    driver: fake.factory,
  });

  const launched = await fake.launched;
  expect(launched.spawnCommand).toEqual(["this-should-not-be-executed", "--flag"]);
  expect(launched.cwd).toBe(worktree);
  expect(launched.env.WORQLOAD_SESSION_ID).toBe(meta.id);
  expect(launched.env.WORQLOAD_ENDPOINT).toBe("http://127.0.0.1:0");

  const client = await connectClient(socketPath);
  client.send({ type: "hello", sinceSeq: 0 });
  await client.next((m) => m.type === "replay_done");

  // Bootstrap is sent asynchronously after the driver factory returns; runHost
  // now opens the unix listener BEFORE the factory, so replay_done can arrive
  // before bootstrap reaches the driver. Wait for it.
  const bootstrapDeadline = Date.now() + 2000;
  while (fake.sent.length < 1 && Date.now() < bootstrapDeadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const bootstrap = fake.sent[0];
  if (!bootstrap) throw new Error("bootstrap message was not delivered");
  expect(bootstrap.source).toBe("bootstrap");
  expect(bootstrap.text).toContain(meta.prompt);

  client.send({ type: "send_user", text: "ping" });
  // Wait for the driver to observe the user message.
  const deadline = Date.now() + 2000;
  while (fake.sent.length < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const userSend = fake.sent[1];
  if (!userSend) throw new Error("driver never received the user message");
  expect(userSend).toEqual({ text: "ping", source: "send_user" });

  client.send({ type: "kill", signal: "SIGTERM" });
  // Wait for the kill to land on the driver.
  const killDeadline = Date.now() + 2000;
  while (fake.killSignals.length === 0 && Date.now() < killDeadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(fake.killSignals).toEqual(["SIGTERM"]);

  // Now finalize: the fake driver doesn't auto-exit on kill — let the test
  // drive the exit so we can validate the contract that runHost waits on
  // driver.exited rather than on the process itself.
  fake.exit(0);
  const code = await hostExit;
  expect(code).toBe(0);
});
