import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
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

function makeFakeTmuxDeps(transcriptDir: string, bootstrapDir = makeTmpDir("tmux-driver-bootstrap")): { deps: TmuxDriverDeps; state: FakeTmuxState } {
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
      transcriptWaitTimeoutMs: 5_000,
      bootstrapFileDir: bootstrapDir,
    },
    state,
  };
}

const noopLog = () => {};
const SAMPLE_SESSION_ID = "abcd1234-0000-0000-0000-000000000000";

async function buildLaunchOptions(
  cwd: string,
  events: SessionDriverEvent[],
  spawnCommand: string[] = ["claude", "--dangerously-skip-permissions"],
  sessionId = SAMPLE_SESSION_ID,
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

test("encodeCwdForClaudeProjects replaces slashes AND dots with hyphens (matches Claude Code's own encoding)", () => {
  expect(encodeCwdForClaudeProjects("/Users/foo/repo")).toBe("-Users-foo-repo");
  expect(encodeCwdForClaudeProjects("/Users/me/ghq/git.example.com/org/repo")).toBe(
    "-Users-me-ghq-git-example-com-org-repo",
  );
  expect(encodeCwdForClaudeProjects("/Users/me/repo/.worktrees/abc")).toBe(
    "-Users-me-repo--worktrees-abc",
  );
  expect(encodeCwdForClaudeProjects("/Users/me/ghq/git.example.com/org/repo/.worktrees/6814b538")).toBe(
    "-Users-me-ghq-git-example-com-org-repo--worktrees-6814b538",
  );
});

test("tmuxSessionName derives a short, prefixed session name", () => {
  expect(tmuxSessionName("abcd1234-5678-...")).toBe("worqload-abcd1234");
});

test("factory returns without spawning tmux — spawn is deferred to the first sendUserMessage call", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  const { deps, state } = makeFakeTmuxDeps(transcriptDir);

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const factory = makeTmuxClaudeDriverFactory(deps);

  const driver = await factory(launch);

  // No tmux commands until the first message is sent.
  expect(state.calls).toEqual([]);

  driver.kill("SIGTERM");
  await driver.exited;
});

test("first sendUserMessage spawns tmux running claude with --session-id and the prompt fed via $(cat <bootstrap-file>)", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  const bootstrapDir = makeTmpDir("tmux-driver-bootstrap");
  const { deps, state } = makeFakeTmuxDeps(transcriptDir, bootstrapDir);

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const factory = makeTmuxClaudeDriverFactory(deps);

  const driver = await factory(launch);
  const bootstrap = "Hello\nMulti-line\nWith \"quotes\" and $dollars and 'apostrophes'";
  await driver.sendUserMessage(bootstrap, "bootstrap");

  // First tmux call is new-session.
  const spawnCall = state.calls[0];
  if (!spawnCall) throw new Error("tmux new-session was not invoked");
  expect(spawnCall.args[0]).toBe("new-session");
  expect(spawnCall.args).toContain("-d");
  const nameIdx = spawnCall.args.indexOf("-s");
  expect(spawnCall.args[nameIdx + 1]).toBe("worqload-abcd1234");
  const cwdIdx = spawnCall.args.indexOf("-c");
  expect(spawnCall.args[cwdIdx + 1]).toBe(cwd);
  // env forwarded
  expect(spawnCall.args.some((a) => a === `WORQLOAD_SESSION_ID=${SAMPLE_SESSION_ID}`)).toBe(true);
  // Trailing args: bash -c <shellCmd>
  const tail = spawnCall.args.slice(-3);
  expect(tail[0]).toBe("bash");
  expect(tail[1]).toBe("-c");
  const shellCmd = tail[2];
  if (typeof shellCmd !== "string") throw new Error("missing shell command");
  // The command must reference the bootstrap file path and use $(cat ...) to
  // read it so multi-line / metachar content survives.
  expect(shellCmd).toContain("$(cat");
  expect(shellCmd).toContain("worqload-bootstrap-");
  // --session-id (fresh path) carries our UUID.
  expect(shellCmd).toContain("--session-id");
  expect(shellCmd).toContain(SAMPLE_SESSION_ID);
  // The cleaned claude argv must be in the shell command.
  expect(shellCmd).toContain("claude");
  expect(shellCmd).toContain("--dangerously-skip-permissions");

  // The bootstrap file itself must exist and contain the exact text.
  const fileNameMatch = shellCmd.match(/worqload-bootstrap-[a-z0-9-]+\.txt/);
  if (!fileNameMatch) throw new Error("could not locate bootstrap file name in shell command");
  const bootstrapPath = join(bootstrapDir, fileNameMatch[0]);
  const written = await readFile(bootstrapPath, "utf8");
  expect(written).toBe(bootstrap);

  driver.kill("SIGTERM");
  await driver.exited;
});

test("resume mode uses --resume <uuid> instead of --session-id <uuid>", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  const { deps, state } = makeFakeTmuxDeps(transcriptDir);

  const events: SessionDriverEvent[] = [];
  // The host adds --continue to spawnCommand for resume sessions; the tmux
  // driver should detect that and switch to --resume <uuid>.
  const launch = await buildLaunchOptions(cwd, events, ["claude", "--dangerously-skip-permissions", "--continue"]);
  const factory = makeTmuxClaudeDriverFactory(deps);

  const driver = await factory(launch);
  await driver.sendUserMessage("RESUMING", "bootstrap");

  const spawnCall = state.calls[0];
  if (!spawnCall) throw new Error("tmux new-session not invoked");
  const shellCmd = spawnCall.args.at(-1);
  if (typeof shellCmd !== "string") throw new Error("missing shell command");
  expect(shellCmd).toContain("--resume");
  expect(shellCmd).toContain(SAMPLE_SESSION_ID);
  // --continue must be stripped (worqload's claude --resume <uuid> is the
  // explicit equivalent and avoids racing with other sessions in the cwd).
  expect(shellCmd).not.toContain("--continue");

  driver.kill("SIGTERM");
  await driver.exited;
});

test("second and later messages go through bracketed paste-buffer + Enter", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  const { deps, state } = makeFakeTmuxDeps(transcriptDir);

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const factory = makeTmuxClaudeDriverFactory(deps);

  const driver = await factory(launch);
  // First call spawns.
  await driver.sendUserMessage("first", "bootstrap");
  const afterSpawn = state.calls.length;
  // Second call should paste.
  await driver.sendUserMessage("second", "send_user");

  const pasteCalls = state.calls.slice(afterSpawn).filter((c) =>
    c.args[0] === "load-buffer" || c.args[0] === "paste-buffer" || c.args[0] === "send-keys",
  );
  expect(pasteCalls.length).toBe(3);
  expect(pasteCalls[0]?.args[0]).toBe("load-buffer");
  expect(pasteCalls[0]?.stdin).toBe("second");
  expect(pasteCalls[1]?.args[0]).toBe("paste-buffer");
  expect(pasteCalls[1]?.args).toContain("-p");
  expect(pasteCalls[2]?.args[0]).toBe("send-keys");
  expect(pasteCalls[2]?.args).toContain("Enter");

  driver.kill("SIGTERM");
  await driver.exited;
});

test("kill issues tmux kill-session and resolves exited", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  const { deps, state } = makeFakeTmuxDeps(transcriptDir);

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const factory = makeTmuxClaudeDriverFactory(deps);

  const driver = await factory(launch);
  // Spawn first so we have something to kill.
  await driver.sendUserMessage("hi", "bootstrap");

  driver.kill("SIGTERM");
  const code = await driver.exited;
  expect(code).toBe(0);
  expect(state.calls.some((c) => c.args[0] === "kill-session")).toBe(true);
});

test("driver tails the predicted transcript path (<projects>/<encoded-cwd>/<sessionId>.jsonl) and emits classified events", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  const { deps } = makeFakeTmuxDeps(transcriptDir);

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const factory = makeTmuxClaudeDriverFactory(deps);

  const driver = await factory(launch);
  await driver.sendUserMessage("hi", "bootstrap");

  // Write the transcript file at the path the driver predicted: it polls
  // <transcriptDir>/<sessionId>.jsonl, NOT "any new file in the dir".
  const transcriptPath = join(transcriptDir, `${SAMPLE_SESSION_ID}.jsonl`);
  await writeFile(transcriptPath, `{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n`);

  // Wait for the first event to arrive.
  const deadline = Date.now() + 2000;
  while (events.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const first = events[0];
  if (!first) throw new Error("no transcript event observed");
  expect(first.kind).toBe("claude_assistant_message");

  await appendFile(transcriptPath, `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}\n`);
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

test("factory returns immediately, without waiting for tmux or the transcript", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  const { deps } = makeFakeTmuxDeps(transcriptDir);

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const factory = makeTmuxClaudeDriverFactory(deps);

  const t0 = Date.now();
  const driver = await factory(launch);
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(200);

  driver.kill("SIGTERM");
  await driver.exited;
});

test("if no transcript file ever appears (after first message), exited resolves with non-zero and the failure is logged", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  const { deps } = makeFakeTmuxDeps(transcriptDir);
  deps.transcriptWaitTimeoutMs = 80;

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const logEntries: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  launch.log = (event, fields) => {
    logEntries.push({ event, fields });
  };
  const factory = makeTmuxClaudeDriverFactory(deps);

  const driver = await factory(launch);
  // Spawn but never produce a transcript.
  await driver.sendUserMessage("hi", "bootstrap");

  const code = await driver.exited;
  expect(code).toBe(1);
  expect(logEntries.some((e) => e.event === "transcript_discovery_failed")).toBe(true);
});

test("exited resolves when tmux has-session returns non-zero (claude exited externally)", async () => {
  const cwd = makeTmpDir("tmux-driver-cwd");
  const transcriptDir = makeTmpDir("tmux-driver-tx");
  await mkdir(transcriptDir, { recursive: true });
  const { deps, state } = makeFakeTmuxDeps(transcriptDir);
  state.hasSessionReplies = [1];

  const events: SessionDriverEvent[] = [];
  const launch = await buildLaunchOptions(cwd, events);
  const factory = makeTmuxClaudeDriverFactory(deps);

  const driver = await factory(launch);
  // Spawn so the has-session poll loop starts checking.
  await driver.sendUserMessage("hi", "bootstrap");

  const code = await driver.exited;
  expect(code).toBe(0);
  // We never called driver.kill(), so kill-session must not appear.
  expect(state.calls.some((c) => c.args[0] === "kill-session")).toBe(false);
});
