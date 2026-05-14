import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  SessionDriverEvent,
  SessionDriverLaunchOptions,
} from "./session-driver";
import {
  encodeCwdForClaudeProjects,
  makeTmuxClaudeDriverFactory,
  tmuxSessionName,
  type TmuxDriverDeps,
  type TmuxRunResult,
} from "./session-driver-tmux";
import { cleanupAll, makeTmpDir } from "./test-helpers";

afterEach(cleanupAll);

interface RecordedCall {
  args: string[];
  stdin: string | undefined;
}

interface FakeTmuxState {
  calls: RecordedCall[];
  // Replies for has-session: each call peels off the next entry. When the array
  // is empty, has-session returns success (session still alive).
  hasSessionReplies: number[];
  // True after kill-session has been received.
  killed: boolean;
}

function makeFakeTmuxDeps(transcriptDir: string): { deps: TmuxDriverDeps; state: FakeTmuxState } {
  const state: FakeTmuxState = {
    calls: [],
    hasSessionReplies: [],
    killed: false,
  };
  const tmuxRun = async (args: string[], opts?: { stdin?: string }): Promise<TmuxRunResult> => {
    state.calls.push({ args: [...args], stdin: opts?.stdin });
    if (args[0] === "kill-session") {
      state.killed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "has-session") {
      if (state.killed) return { exitCode: 1, stdout: "", stderr: "no such session" };
      const next = state.hasSessionReplies.shift();
      if (next !== undefined) return { exitCode: next, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return {
    deps: {
      tmuxRun,
      resolveTranscriptDir: () => transcriptDir,
      pollIntervalMs: 10,
    },
    state,
  };
}

const noopLog = () => {};

async function buildLaunchOptions(
  cwd: string,
  events: SessionDriverEvent[],
  spawnCommand: string[] = ["claude", "--dangerously-skip-permissions"],
  sessionId = "abcd1234-0000-0000-0000-000000000000",
): Promise<SessionDriverLaunchOptions> {
  return {
    cwd,
    env: {
      WORQLOAD_SESSION_ID: sessionId,
      WORQLOAD_ENDPOINT: "http://127.0.0.1:0",
    },
    spawnCommand,
    onEvent: (e) => {
      events.push(e);
    },
    log: noopLog,
  };
}

test("encodeCwdForClaudeProjects replaces slashes with hyphens", () => {
  expect(encodeCwdForClaudeProjects("/Users/foo/repo")).toBe("-Users-foo-repo");
});

test("tmuxSessionName derives a short, prefixed session name", () => {
  expect(tmuxSessionName("abcd1234-5678-...")).toBe("worqload-abcd1234");
});

test("driver spawns a detached tmux session with the cwd, env, and spawnCommand", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  // Pre-create a transcript so the driver doesn't block looking for one.
  await writeFile(join(transcriptDir, "preexisting.jsonl"), "");
  const { deps, state } = makeFakeTmuxDeps(transcriptDir);

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const factory = makeTmuxClaudeDriverFactory(deps);

  // Make a fresh transcript file appear *after* spawn so the wait loop returns.
  const driverPromise = factory(launch);
  setTimeout(() => {
    void writeFile(join(transcriptDir, "new-session.jsonl"), "");
  }, 30);
  const driver = await driverPromise;

  // The first call must be new-session with the expected basic shape.
  const spawnCall = state.calls[0];
  if (!spawnCall) throw new Error("no tmux call recorded");
  expect(spawnCall.args[0]).toBe("new-session");
  expect(spawnCall.args).toContain("-d");
  // Session naming
  const nameIdx = spawnCall.args.indexOf("-s");
  expect(nameIdx).toBeGreaterThan(-1);
  expect(spawnCall.args[nameIdx + 1]).toBe("worqload-abcd1234");
  // cwd
  const cwdIdx = spawnCall.args.indexOf("-c");
  expect(spawnCall.args[cwdIdx + 1]).toBe(cwd);
  // env: WORQLOAD_SESSION_ID must be forwarded via `-e`
  expect(spawnCall.args.some((a) => a === "WORQLOAD_SESSION_ID=abcd1234-0000-0000-0000-000000000000")).toBe(true);
  // The spawn argv tail is the claude command.
  const lastTwo = spawnCall.args.slice(-2);
  expect(lastTwo).toEqual(["claude", "--dangerously-skip-permissions"]);

  // Cleanup.
  driver.kill("SIGTERM");
  await driver.exited;
});

test("driver sends a user message via load-buffer, paste-buffer, Enter", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  await writeFile(join(transcriptDir, "active.jsonl"), "");
  const { deps, state } = makeFakeTmuxDeps(transcriptDir);

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const factory = makeTmuxClaudeDriverFactory(deps);

  // Trigger a new transcript so spawn finishes.
  setTimeout(() => {
    void writeFile(join(transcriptDir, "fresh.jsonl"), "");
  }, 30);
  const driver = await factory(launch);

  const initialCallCount = state.calls.length;
  await driver.sendUserMessage("ping", "bootstrap");

  const sendCalls = state.calls.slice(initialCallCount).filter((c) =>
    c.args[0] === "load-buffer" || c.args[0] === "paste-buffer" || c.args[0] === "send-keys",
  );
  expect(sendCalls.length).toBe(3);
  expect(sendCalls[0]?.args[0]).toBe("load-buffer");
  expect(sendCalls[0]?.stdin).toBe("ping");
  expect(sendCalls[1]?.args[0]).toBe("paste-buffer");
  expect(sendCalls[1]?.args).toContain("-t");
  expect(sendCalls[1]?.args[sendCalls[1].args.indexOf("-t") + 1]).toBe("worqload-abcd1234");
  expect(sendCalls[2]?.args[0]).toBe("send-keys");
  expect(sendCalls[2]?.args).toContain("Enter");

  driver.kill("SIGTERM");
  await driver.exited;
});

test("kill issues tmux kill-session and resolves exited", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  await writeFile(join(transcriptDir, "active.jsonl"), "");
  const { deps, state } = makeFakeTmuxDeps(transcriptDir);

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const factory = makeTmuxClaudeDriverFactory(deps);

  setTimeout(() => {
    void writeFile(join(transcriptDir, "fresh.jsonl"), "");
  }, 30);
  const driver = await factory(launch);

  driver.kill("SIGTERM");
  const code = await driver.exited;
  expect(code).toBe(0);
  expect(state.calls.some((c) => c.args[0] === "kill-session")).toBe(true);
});

test("driver tails the freshly-created transcript jsonl and emits classified events", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  // Pre-existing transcript that must be ignored.
  await writeFile(join(transcriptDir, "old.jsonl"), `{"type":"assistant","message":{"content":[{"type":"text","text":"old"}]}}\n`);
  const { deps } = makeFakeTmuxDeps(transcriptDir);

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const factory = makeTmuxClaudeDriverFactory(deps);

  // After spawn, write the new transcript with one assistant message.
  const newTranscript = join(transcriptDir, "new.jsonl");
  setTimeout(() => {
    void writeFile(newTranscript, `{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n`);
  }, 30);
  const driver = await factory(launch);

  // Wait for the first event to arrive.
  const deadline = Date.now() + 2000;
  while (events.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const first = events[0];
  if (!first) throw new Error("no transcript event observed");
  expect(first.kind).toBe("claude_assistant_message");
  expect((first.payload as { type?: string }).type).toBe("assistant");

  // Append another line — driver must keep tailing.
  await appendFile(newTranscript, `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}\n`);
  const deadline2 = Date.now() + 2000;
  while (events.length < 2 && Date.now() < deadline2) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const second = events[1];
  if (!second) throw new Error("second event missed");
  expect(second.kind).toBe("claude_tool_use");

  driver.kill("SIGTERM");
  await driver.exited;
});

test("exited resolves when tmux has-session returns non-zero (claude exited externally)", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  await mkdir(transcriptDir, { recursive: true });
  const { deps, state } = makeFakeTmuxDeps(transcriptDir);
  // Make has-session report "gone" on the very first poll.
  state.hasSessionReplies = [1];

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const factory = makeTmuxClaudeDriverFactory(deps);

  setTimeout(() => {
    void writeFile(join(transcriptDir, "fresh.jsonl"), "");
  }, 30);
  const driver = await factory(launch);

  const code = await driver.exited;
  expect(code).toBe(0);
  // We never called driver.kill(), so the kill-session command must not be in
  // the call log — the driver detected the missing session via has-session.
  expect(state.calls.some((c) => c.args[0] === "kill-session")).toBe(false);
});
