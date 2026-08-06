import { test, expect, afterEach } from "bun:test";
import {
  createSession,
  validateTransition,
  isTerminal,
  saveSessionMeta,
  loadSessionMeta,
  listSessionMetas,
  reorderSessions,
  isReviseModeEnabled,
} from "./session";
import type { SessionStatus, SessionMeta } from "./session";
import { makeTmpDir, cleanupAll } from "./test-helpers";

afterEach(cleanupAll);

function tmpDir(): string {
  return makeTmpDir("session-test");
}

const baseParams = {
  prompt: "do something",
  baseBranch: "main",
  baseCommit: "abc123",
  worktreePath: "/tmp/wt/abc",
  branchName: "do-something",
};

test("createSession returns valid meta", () => {
  const meta = createSession(baseParams);

  expect(meta.id).toBeDefined();
  expect(meta.prompt).toBe("do something");
  expect(meta.baseBranch).toBe("main");
  expect(meta.baseCommit).toBe("abc123");
  expect(meta.worktreePath).toBe("/tmp/wt/abc");
  expect(meta.branchName).toBe("do-something");
  expect(meta.agentName).toBeUndefined();
  expect(meta.status).toBe("running");
  expect(meta.createdAt).toBeDefined();
  expect(meta.endedAt).toBeUndefined();
  expect(meta.title).toBeUndefined();
  expect(meta.hostPid).toBeUndefined();
  expect(meta.hostSocketPath).toBeUndefined();
});

test("createSession trims whitespace from prompt", () => {
  const meta = createSession({ ...baseParams, prompt: "  hello  " });
  expect(meta.prompt).toBe("hello");
});

test("createSession throws on empty prompt", () => {
  expect(() => createSession({ ...baseParams, prompt: "" })).toThrow("prompt must not be empty");
  expect(() => createSession({ ...baseParams, prompt: "   " })).toThrow("prompt must not be empty");
});

test("createSession accepts optional title", () => {
  const meta = createSession({ ...baseParams, title: "my session" });
  expect(meta.title).toBe("my session");
});

test("createSession accepts optional agentName", () => {
  const meta = createSession({ ...baseParams, agentName: "codex" });
  expect(meta.agentName).toBe("codex");
});

test("createSession accepts optional driverName", () => {
  const meta = createSession({ ...baseParams, driverName: "tmux" });
  expect(meta.driverName).toBe("tmux");
});

test("createSession accepts optional model", () => {
  const meta = createSession({ ...baseParams, model: "opus" });
  expect(meta.model).toBe("opus");
});

test("createSession with startPaused sets status to stopped", () => {
  const meta = createSession({ ...baseParams, startPaused: true });
  expect(meta.status).toBe("stopped");
});

test("createSession without startPaused sets status to running", () => {
  const meta = createSession(baseParams);
  expect(meta.status).toBe("running");
});

test("createSession omits model when not provided", () => {
  const meta = createSession(baseParams);
  expect(meta.model).toBeUndefined();
});

test("createSession omits driverName when not provided", () => {
  const meta = createSession(baseParams);
  expect(meta.driverName).toBeUndefined();
});

test("isReviseModeEnabled defaults OFF so reports are stored on first submission unless opted in", () => {
  const meta = createSession(baseParams);
  // A new session leaves the flag absent; absent means off, so reports are
  // stored on first submission until the human explicitly turns revise mode on.
  expect(meta.reviseModeEnabled).toBeUndefined();
  expect(isReviseModeEnabled(meta)).toBe(false);
});

test("isReviseModeEnabled is true only when the human explicitly turned it on", () => {
  const off: SessionMeta = { ...createSession(baseParams), reviseModeEnabled: false };
  const on: SessionMeta = { ...createSession(baseParams), reviseModeEnabled: true };
  expect(isReviseModeEnabled(off)).toBe(false);
  expect(isReviseModeEnabled(on)).toBe(true);
});

test("validateTransition allows valid transitions", () => {
  const valid: [SessionStatus, SessionStatus][] = [
    ["running", "waiting_human"],
    ["running", "stopped"],
    ["running", "crashed"],
    ["waiting_human", "running"],
    ["waiting_human", "stopped"],
    ["waiting_human", "crashed"],
    // resume reactivates a terminal session
    ["stopped", "running"],
    ["crashed", "running"],
  ];
  for (const [from, to] of valid) {
    expect(() => validateTransition(from, to)).not.toThrow();
  }
});

test("validateTransition rejects invalid transitions", () => {
  const invalid: [SessionStatus, SessionStatus][] = [
    ["stopped", "waiting_human"],
    ["stopped", "crashed"],
    ["crashed", "waiting_human"],
    ["crashed", "stopped"],
    ["running", "running"],
  ];
  for (const [from, to] of invalid) {
    expect(() => validateTransition(from, to)).toThrow("Invalid status transition");
  }
});

test("isTerminal recognizes stopped and crashed", () => {
  expect(isTerminal("running")).toBe(false);
  expect(isTerminal("waiting_human")).toBe(false);
  expect(isTerminal("stopped")).toBe(true);
  expect(isTerminal("crashed")).toBe(true);
});








