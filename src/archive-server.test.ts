import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openArchiveDb, insertReport, insertFeedback } from "./archive-store";
import { startArchiveServer } from "./archive-server";

let dir: string;
let dbPath: string;
let baseUrl: string;
let shutdown: () => void;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "archive-server-test-"));
  dbPath = join(dir, "archive.db");
  const db = openArchiveDb(dbPath);
  insertReport(db, {
    repo: "github.com/foo/bar", sessionId: "s1", filename: "001-plan.md",
    slug: "plan", body: "# Plan\nDo the thing.", replyTo: null,
    anchorPath: null, anchorLineStart: null, anchorLineEnd: null,
    createdAt: "2026-08-24T01:00:00Z",
  });
  insertReport(db, {
    repo: "github.com/foo/bar", sessionId: "s1", filename: "002-done.md",
    slug: "done", body: "Done.", replyTo: null,
    anchorPath: null, anchorLineStart: null, anchorLineEnd: null,
    createdAt: "2026-08-24T02:00:00Z",
  });
  insertFeedback(db, {
    repo: "github.com/foo/bar", sessionId: "s1", filename: "001-fb.md",
    body: "Fix the bug.", anchorPath: null, anchorLineStart: null, anchorLineEnd: null,
    createdAt: "2026-08-24T01:30:00Z",
  });
  insertReport(db, {
    repo: "github.com/baz/qux", sessionId: "s2", filename: "001-x.md",
    slug: "x", body: "Other repo.", replyTo: null,
    anchorPath: null, anchorLineStart: null, anchorLineEnd: null,
    createdAt: "2026-08-24T03:00:00Z",
  });
  db.close();

  const result = await startArchiveServer({ port: 0, archiveDbPath: dbPath });
  baseUrl = `http://127.0.0.1:${result.server.port}`;
  shutdown = result.shutdown;
});

afterEach(async () => {
  shutdown();
  await rm(dir, { recursive: true, force: true });
});

test("GET /api/sessions returns all sessions", async () => {
  const res = await fetch(`${baseUrl}/api/sessions`);
  expect(res.status).toBe(200);
  const { sessions } = await res.json();
  expect(sessions).toHaveLength(2);
  expect(sessions[0].sessionId).toBe("s2");
  expect(sessions[1].sessionId).toBe("s1");
});

test("GET /api/sessions?repo= filters by repo", async () => {
  const res = await fetch(`${baseUrl}/api/sessions?repo=${encodeURIComponent("github.com/foo/bar")}`);
  const { sessions } = await res.json();
  expect(sessions).toHaveLength(1);
  expect(sessions[0].sessionId).toBe("s1");
});

test("GET /api/sessions/:id/reports returns session reports", async () => {
  const res = await fetch(`${baseUrl}/api/sessions/s1/reports`);
  const { reports } = await res.json();
  expect(reports).toHaveLength(2);
  expect(reports[0].slug).toBe("plan");
});

test("GET /api/sessions/:id/feedback returns session feedback", async () => {
  const res = await fetch(`${baseUrl}/api/sessions/s1/feedback`);
  const { feedback } = await res.json();
  expect(feedback).toHaveLength(1);
  expect(feedback[0].body).toBe("Fix the bug.");
});

test("GET /api/reports returns all reports", async () => {
  const res = await fetch(`${baseUrl}/api/reports`);
  const { reports } = await res.json();
  expect(reports).toHaveLength(3);
});

test("GET /api/feedback returns all feedback", async () => {
  const res = await fetch(`${baseUrl}/api/feedback`);
  const { feedback } = await res.json();
  expect(feedback).toHaveLength(1);
});

test("GET /api/search returns matching reports and feedback", async () => {
  const res = await fetch(`${baseUrl}/api/search?q=Plan`);
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.reports).toHaveLength(1);
  expect(data.reports[0].body).toContain("Plan");
  expect(data.feedback).toHaveLength(0);
});

test("GET /api/search matches feedback body", async () => {
  const res = await fetch(`${baseUrl}/api/search?q=bug`);
  const data = await res.json();
  expect(data.reports).toHaveLength(0);
  expect(data.feedback).toHaveLength(1);
  expect(data.feedback[0].body).toContain("bug");
});

test("GET /api/search is case-insensitive", async () => {
  const res = await fetch(`${baseUrl}/api/search?q=plan`);
  const data = await res.json();
  expect(data.reports).toHaveLength(1);
});

test("GET /api/search with empty q returns 400", async () => {
  const res = await fetch(`${baseUrl}/api/search?q=`);
  expect(res.status).toBe(400);
});

test("GET /api/search without q returns 400", async () => {
  const res = await fetch(`${baseUrl}/api/search`);
  expect(res.status).toBe(400);
});

test("unknown API path returns 404", async () => {
  const res = await fetch(`${baseUrl}/api/nonexistent`);
  expect(res.status).toBe(404);
});

test("GET / serves index.html", async () => {
  const res = await fetch(`${baseUrl}/`);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("<html");
});
