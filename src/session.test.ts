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
  const a = createSession({ ...baseParams, createdAt: "2026-01-01T00:00:00Z" });
  const b = createSession({ ...baseParams, createdAt: "2026-01-01T00:00:01Z" });
  const c = createSession({ ...baseParams, createdAt: "2026-01-01T00:00:02Z" });
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
  const a = createSession({ ...baseParams, createdAt: "2026-01-01T00:00:00Z" });
  const b = createSession({ ...baseParams, createdAt: "2026-01-01T00:00:01Z" });
  const c = createSession({ ...baseParams, createdAt: "2026-01-01T00:00:02Z" });
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
  const a = createSession({ ...baseParams, createdAt: "2026-01-01T00:00:00Z" });
  const b = createSession({ ...baseParams, createdAt: "2026-01-01T00:00:01Z" });
  await saveSessionMeta(a, dir);
  await saveSessionMeta(b, dir);
  await reorderSessions([a.id, b.id], dir);

  const fresh = createSession({ ...baseParams, createdAt: "2026-01-01T00:00:02Z" });
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
