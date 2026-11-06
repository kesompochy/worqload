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

test("upsertSession stores initial prompt and is retrievable via listAllSessions", async () => {
  const { openArchiveDb, insertReport, upsertSession, listAllSessions } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    insertReport(db, {
      repo: "github.com/foo/bar", sessionId: "s1", filename: "001-x.md",
      slug: "x", body: "b", replyTo: null,
      anchorPath: null, anchorLineStart: null, anchorLineEnd: null,
      createdAt: "2026-08-24T01:00:00Z",
    });
    upsertSession(db, {
      sessionId: "s1",
      repo: "github.com/foo/bar",
      initialPrompt: "Fix the login bug in the auth module",
      createdAt: "2026-08-24T00:00:00Z",
    });
    const sessions = listAllSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].initialPrompt).toBe("Fix the login bug in the auth module");
  } finally {
    db.close();
  }
});

test("upsertSession is idempotent — second call does not overwrite", async () => {
  const { openArchiveDb, upsertSession } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    upsertSession(db, {
      sessionId: "s1", repo: "github.com/foo/bar",
      initialPrompt: "original prompt", createdAt: "2026-08-24T00:00:00Z",
    });
    upsertSession(db, {
      sessionId: "s1", repo: "github.com/foo/bar",
      initialPrompt: "different prompt", createdAt: "2026-08-25T00:00:00Z",
    });
    const row = db.query("SELECT initial_prompt FROM sessions WHERE session_id = 's1'").get() as { initial_prompt: string };
    expect(row.initial_prompt).toBe("original prompt");
  } finally {
    db.close();
  }
});

test("listAllSessions returns null initialPrompt when no session row exists", async () => {
  const { openArchiveDb, insertReport, listAllSessions } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    insertReport(db, {
      repo: "github.com/foo/bar", sessionId: "s1", filename: "001-x.md",
      slug: "x", body: "b", replyTo: null,
      anchorPath: null, anchorLineStart: null, anchorLineEnd: null,
      createdAt: "2026-08-24T01:00:00Z",
    });
    const sessions = listAllSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].initialPrompt).toBeNull();
  } finally {
    db.close();
  }
});

test("openArchiveDb creates sessions table", async () => {
  const { openArchiveDb } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain("sessions");
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

test("insertPolish stores a polish with its draft, rounds and outcome", async () => {
  const { openArchiveDb, insertPolish, listPolishes } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    insertPolish(db, {
      repo: "github.com/foo/bar",
      sessionId: "abc-123",
      kind: "report",
      slug: "plan",
      draft: "原稿",
      rounds: ["1回目の出力", "2回目の出力"],
      outcome: "stored",
      result: "推敲版",
      storedFilename: "001-plan.md",
      createdAt: "2026-10-29T00:00:00Z",
      readerObjection: null,
      mergedReports: [],
    });
    expect(listPolishes(db, "abc-123")).toEqual([{
      repo: "github.com/foo/bar",
      sessionId: "abc-123",
      kind: "report",
      slug: "plan",
      draft: "原稿",
      rounds: ["1回目の出力", "2回目の出力"],
      outcome: "stored",
      result: "推敲版",
      storedFilename: "001-plan.md",
      createdAt: "2026-10-29T00:00:00Z",
      readerObjection: null,
      mergedReports: [],
    }]);
    expect(listPolishes(db, "other")).toEqual([]);
  } finally {
    db.close();
  }
});

test("insertEscalation stores an escalation once per session and filename", async () => {
  const { openArchiveDb, insertEscalation, listEscalations } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    const row = { repo: "github.com/foo/bar", sessionId: "abc-123", filename: "001-command-approval.md", body: "理由", command: "npm publish", createdAt: "2026-10-29T00:00:00Z" };
    insertEscalation(db, row);
    insertEscalation(db, row);
    expect(listEscalations(db, "abc-123")).toEqual([row]);
  } finally {
    db.close();
  }
});

test("insertCancellation stores what was cancelled and why", async () => {
  const { openArchiveDb, insertCancellation, listCancellations } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    const row = { repo: "github.com/foo/bar", sessionId: "abc-123", kind: "escalation" as const, target: "001-lib.md", reason: null, createdAt: "2026-10-29T00:00:00Z" };
    insertCancellation(db, row);
    expect(listCancellations(db, "abc-123")).toEqual([row]);
  } finally {
    db.close();
  }
});

test("openArchiveDb waits for another process's write lock instead of skipping the schema", async () => {
  const { openArchiveDb } = await loadModule();
  // Another serve process holding the write lock, as when several reload together.
  const holder = Bun.spawn(["bun", "-e", `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(dbPath)});
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("BEGIN IMMEDIATE");
    db.exec("CREATE TABLE holder (x)");
    console.log("locked");
    await Bun.sleep(500);
    db.exec("COMMIT");
  `], { stdout: "pipe" });
  await holder.stdout.getReader().read();

  const db = openArchiveDb(dbPath);
  try {
    const names = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
    expect(names).toContain("polishes");
  } finally {
    db.close();
    await holder.exited;
  }
});

test("a polish keeps the reader's objection, and an archive from before the column gains it", async () => {
  const { Database } = await import("bun:sqlite");
  const old = new Database(dbPath);
  old.exec(`CREATE TABLE polishes (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, slug TEXT NOT NULL, draft TEXT NOT NULL, rounds TEXT NOT NULL, outcome TEXT NOT NULL, result TEXT NOT NULL, stored_filename TEXT, created_at TEXT NOT NULL)`);
  old.close();
  const { openArchiveDb, insertPolish, listPolishes } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    const row = { repo: "r", sessionId: "s", kind: "report" as const, slug: "x", draft: "d", rounds: [], outcome: "stored" as const, result: "d", storedFilename: "001-x.md", createdAt: "t", mergedReports: [] };
    insertPolish(db, { ...row, readerObjection: "冒頭が作業の記録" });
    insertPolish(db, { ...row, readerObjection: null });
    expect(listPolishes(db, "s").map(p => p.readerObjection)).toEqual(["冒頭が作業の記録", null]);
  } finally {
    db.close();
  }
});

test("a polish keeps the reports its stored report replaced, and an archive from before the column reads them as none", async () => {
  const { Database } = await import("bun:sqlite");
  const old = new Database(dbPath);
  old.exec(`CREATE TABLE polishes (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, slug TEXT NOT NULL, draft TEXT NOT NULL, rounds TEXT NOT NULL, outcome TEXT NOT NULL, result TEXT NOT NULL, stored_filename TEXT, created_at TEXT NOT NULL, reader_objection TEXT)`);
  old.exec(`INSERT INTO polishes (repo, session_id, kind, slug, draft, rounds, outcome, result, stored_filename, created_at) VALUES ('r', 's', 'report', 'x', 'd', '[]', 'stored', 'd', '001-x.md', 't')`);
  old.close();
  const { openArchiveDb, insertPolish, listPolishes } = await loadModule();
  const db = openArchiveDb(dbPath);
  try {
    insertPolish(db, { repo: "r", sessionId: "s", kind: "report", slug: "y", draft: "d", rounds: [], outcome: "stored", result: "d", storedFilename: "003-y.md", createdAt: "t", readerObjection: null, mergedReports: ["001-x.md", "002-z.md"] });
    expect(listPolishes(db, "s").map(p => p.mergedReports)).toEqual([[], ["001-x.md", "002-z.md"]]);
  } finally {
    db.close();
  }
});
