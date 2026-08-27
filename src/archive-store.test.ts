import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "archive-store-test-"));
  dbPath = join(dir, "archive.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function loadModule() {
  return await import("./archive-store");
}

test("openArchiveDb creates tables on first open", async () => {
  const { openArchiveDb } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain("reports");
    expect(names).toContain("feedback");
  } finally {
    db.close();
  }
});

test("insertReport stores a report and is retrievable", async () => {
  const { openArchiveDb, insertReport, listReports } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    insertReport(db, {
      repo: "github.com/foo/bar",
      sessionId: "abc-123",
      filename: "001-plan.md",
      slug: "plan",
      body: "# Plan\n\nDo the thing.",
      replyTo: null,
      anchorPath: null,
      anchorLineStart: null,
      anchorLineEnd: null,
      createdAt: "2026-08-24T00:00:00Z",
    });
    const rows = listReports(db, "abc-123");
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("# Plan\n\nDo the thing.");
    expect(rows[0].repo).toBe("github.com/foo/bar");
  } finally {
    db.close();
  }
});

test("insertFeedback stores feedback and is retrievable", async () => {
  const { openArchiveDb, insertFeedback, listFeedback } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    insertFeedback(db, {
      repo: "github.com/foo/bar",
      sessionId: "abc-123",
      filename: "001-feedback.md",
      body: "Fix the bug.",
      anchorPath: null,
      anchorLineStart: null,
      anchorLineEnd: null,
      createdAt: "2026-08-24T00:00:00Z",
    });
    const rows = listFeedback(db, "abc-123");
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("Fix the bug.");
  } finally {
    db.close();
  }
});

test("insertReport is idempotent on session_id + filename", async () => {
  const { openArchiveDb, insertReport, listReports } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    const row = {
      repo: "github.com/foo/bar",
      sessionId: "abc-123",
      filename: "001-plan.md",
      slug: "plan",
      body: "original",
      replyTo: null,
      anchorPath: null,
      anchorLineStart: null,
      anchorLineEnd: null,
      createdAt: "2026-08-24T00:00:00Z",
    };
    insertReport(db, row);
    insertReport(db, { ...row, body: "updated" });
    const rows = listReports(db, "abc-123");
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("original");
  } finally {
    db.close();
  }
});

test("insertFeedback is idempotent on session_id + filename", async () => {
  const { openArchiveDb, insertFeedback, listFeedback } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    const row = {
      repo: "github.com/foo/bar",
      sessionId: "abc-123",
      filename: "001-feedback.md",
      body: "original",
      anchorPath: null,
      anchorLineStart: null,
      anchorLineEnd: null,
      createdAt: "2026-08-24T00:00:00Z",
    };
    insertFeedback(db, row);
    insertFeedback(db, { ...row, body: "updated" });
    const rows = listFeedback(db, "abc-123");
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("original");
  } finally {
    db.close();
  }
});

test("listReports filters by session_id", async () => {
  const { openArchiveDb, insertReport, listReports } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    const base = {
      repo: "github.com/foo/bar",
      slug: "x",
      body: "b",
      replyTo: null,
      anchorPath: null,
      anchorLineStart: null,
      anchorLineEnd: null,
      createdAt: "2026-08-24T00:00:00Z",
    };
    insertReport(db, { ...base, sessionId: "s1", filename: "001-x.md" });
    insertReport(db, { ...base, sessionId: "s2", filename: "001-x.md" });
    expect(listReports(db, "s1")).toHaveLength(1);
    expect(listReports(db, "s2")).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("listAllReports returns reports across sessions ordered by created_at desc", async () => {
  const { openArchiveDb, insertReport, listAllReports } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    const base = {
      repo: "github.com/foo/bar",
      slug: "x",
      body: "b",
      replyTo: null,
      anchorPath: null,
      anchorLineStart: null,
      anchorLineEnd: null,
    };
    insertReport(db, { ...base, sessionId: "s1", filename: "001-x.md", createdAt: "2026-08-24T01:00:00Z" });
    insertReport(db, { ...base, sessionId: "s2", filename: "001-x.md", createdAt: "2026-08-24T02:00:00Z" });
    insertReport(db, { ...base, sessionId: "s1", filename: "002-y.md", createdAt: "2026-08-24T03:00:00Z" });
    const rows = listAllReports(db);
    expect(rows).toHaveLength(3);
    expect(rows[0].filename).toBe("002-y.md");
    expect(rows[1].sessionId).toBe("s2");
    expect(rows[2].createdAt).toBe("2026-08-24T01:00:00Z");
  } finally {
    db.close();
  }
});

test("listAllReports filters by repo", async () => {
  const { openArchiveDb, insertReport, listAllReports } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    const base = {
      slug: "x",
      body: "b",
      replyTo: null,
      anchorPath: null,
      anchorLineStart: null,
      anchorLineEnd: null,
      createdAt: "2026-08-24T00:00:00Z",
    };
    insertReport(db, { ...base, repo: "github.com/foo/bar", sessionId: "s1", filename: "001-x.md" });
    insertReport(db, { ...base, repo: "github.com/baz/qux", sessionId: "s2", filename: "001-x.md" });
    const rows = listAllReports(db, { repo: "github.com/foo/bar" });
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("s1");
  } finally {
    db.close();
  }
});

test("listAllFeedback returns feedback across sessions ordered by created_at desc", async () => {
  const { openArchiveDb, insertFeedback, listAllFeedback } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    const base = {
      repo: "github.com/foo/bar",
      body: "fb",
      anchorPath: null,
      anchorLineStart: null,
      anchorLineEnd: null,
    };
    insertFeedback(db, { ...base, sessionId: "s1", filename: "001-fb.md", createdAt: "2026-08-24T01:00:00Z" });
    insertFeedback(db, { ...base, sessionId: "s2", filename: "001-fb.md", createdAt: "2026-08-24T02:00:00Z" });
    const rows = listAllFeedback(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].sessionId).toBe("s2");
  } finally {
    db.close();
  }
});

test("listAllSessions returns distinct session_ids with latest created_at", async () => {
  const { openArchiveDb, insertReport, insertFeedback, listAllSessions } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    insertReport(db, {
      repo: "github.com/foo/bar", sessionId: "s1", filename: "001-x.md",
      slug: "x", body: "b", replyTo: null,
      anchorPath: null, anchorLineStart: null, anchorLineEnd: null,
      createdAt: "2026-08-24T01:00:00Z",
    });
    insertReport(db, {
      repo: "github.com/foo/bar", sessionId: "s1", filename: "002-y.md",
      slug: "y", body: "b", replyTo: null,
      anchorPath: null, anchorLineStart: null, anchorLineEnd: null,
      createdAt: "2026-08-24T03:00:00Z",
    });
    insertFeedback(db, {
      repo: "github.com/foo/bar", sessionId: "s2", filename: "001-fb.md",
      body: "fb", anchorPath: null, anchorLineStart: null, anchorLineEnd: null,
      createdAt: "2026-08-24T02:00:00Z",
    });
    const sessions = listAllSessions(db);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].sessionId).toBe("s1");
    expect(sessions[0].latestAt).toBe("2026-08-24T03:00:00Z");
    expect(sessions[1].sessionId).toBe("s2");
  } finally {
    db.close();
  }
});

test("openArchiveDb creates parent directories", async () => {
  const { openArchiveDb } = await loadModule();
  const nested = join(dir, "a", "b", "archive.db");
  const db = openArchiveDb(nested);
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});
