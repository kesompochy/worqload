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

test("save then load round-trips a session meta", async () => {
  const dir = tmpDir();
  const meta = createSession(baseParams);
  await saveSessionMeta(meta, dir);

  const loaded = await loadSessionMeta(meta.id, dir);
  expect(loaded).toEqual(meta);
});

test("loadSessionMeta returns null when session does not exist", async () => {
  const dir = tmpDir();
  const loaded = await loadSessionMeta("nonexistent", dir);
  expect(loaded).toBeNull();
});

test("listSessionMetas returns empty array when directory does not exist", async () => {
  const dir = tmpDir();
  const list = await listSessionMetas(dir);
  expect(list).toEqual([]);
});

test("listSessionMetas returns all sessions sorted by createdAt desc", async () => {
  const dir = tmpDir();
  const a = createSession(baseParams);
  const b = createSession(baseParams);
  // ensure timestamps differ
  await new Promise(r => setTimeout(r, 10));
  const c = createSession(baseParams);
  await saveSessionMeta(a, dir);
  await saveSessionMeta(b, dir);
  await saveSessionMeta(c, dir);

  const list = await listSessionMetas(dir);
  expect(list).toHaveLength(3);
  // newest first
  expect(list[0].createdAt >= list[1].createdAt).toBe(true);
  expect(list[1].createdAt >= list[2].createdAt).toBe(true);
});

test("reorderSessions stamps sortOrder and listSessionMetas honours it", async () => {
  const dir = tmpDir();
  const a = createSession(baseParams);
  await new Promise(r => setTimeout(r, 10));
  const b = createSession(baseParams);
  await new Promise(r => setTimeout(r, 10));
  const c = createSession(baseParams);
  await saveSessionMeta(a, dir);
  await saveSessionMeta(b, dir);
  await saveSessionMeta(c, dir);

  // default: newest first
  expect((await listSessionMetas(dir)).map(m => m.id)).toEqual([c.id, b.id, a.id]);

  await reorderSessions([a.id, c.id, b.id], dir);
  expect((await loadSessionMeta(a.id, dir))?.sortOrder).toBe(0);
  expect((await listSessionMetas(dir)).map(m => m.id)).toEqual([a.id, c.id, b.id]);
});

test("listSessionMetas floats a session without sortOrder above reordered ones", async () => {
  const dir = tmpDir();
  const a = createSession(baseParams);
  await new Promise(r => setTimeout(r, 10));
  const b = createSession(baseParams);
  await saveSessionMeta(a, dir);
  await saveSessionMeta(b, dir);
  await reorderSessions([a.id, b.id], dir);

  await new Promise(r => setTimeout(r, 10));
  const fresh = createSession(baseParams);
  await saveSessionMeta(fresh, dir);

  expect((await listSessionMetas(dir)).map(m => m.id)).toEqual([fresh.id, a.id, b.id]);
});

test("reorderSessions skips ids with no session on disk", async () => {
  const dir = tmpDir();
  const a = createSession(baseParams);
  await saveSessionMeta(a, dir);
  await reorderSessions(["ghost", a.id], dir);
  expect((await loadSessionMeta(a.id, dir))?.sortOrder).toBe(1);
});

test("saveSessionMeta updates an existing session", async () => {
  const dir = tmpDir();
  const meta = createSession(baseParams);
  await saveSessionMeta(meta, dir);

  const updated = { ...meta, status: "waiting_human" as const, hostPid: 1234 };
  await saveSessionMeta(updated, dir);

  const loaded = await loadSessionMeta(meta.id, dir);
  expect(loaded?.status).toBe("waiting_human");
  expect(loaded?.hostPid).toBe(1234);
});
