import { expect, test, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "archive-backup-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function seedDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      session_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      slug TEXT,
      body TEXT NOT NULL,
      reply_to TEXT,
      anchor_path TEXT,
      anchor_line_start INTEGER,
      anchor_line_end INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, filename)
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      session_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      body TEXT NOT NULL,
      anchor_path TEXT,
      anchor_line_start INTEGER,
      anchor_line_end INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, filename)
    );
  `);
  db.query(
    "INSERT INTO reports (repo, session_id, filename, slug, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("repo", "sess-1", "001-test.md", "test", "hello", "2026-08-28T00:00:00Z");
  return db;
}

describe("archive-backup", () => {
  test("vacuumSnapshot creates a valid copy of the database", async () => {
    const { vacuumSnapshot } = await import("./archive-backup");

    const srcPath = join(dir, "archive.db");
    const srcDb = seedDb(srcPath);
    srcDb.close();

    const destPath = join(dir, "backup.db");
    vacuumSnapshot(srcPath, destPath);

    const destDb = new Database(destPath, { readonly: true });
    try {
      const rows = destDb.query("SELECT * FROM reports").all() as { body: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe("hello");
    } finally {
      destDb.close();
    }
  });

  test("vacuumSnapshot captures uncommitted WAL data", async () => {
    const { vacuumSnapshot } = await import("./archive-backup");

    const srcPath = join(dir, "archive.db");
    const srcDb = seedDb(srcPath);
    srcDb.query(
      "INSERT INTO reports (repo, session_id, filename, slug, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("repo", "sess-2", "002-extra.md", "extra", "world", "2026-08-28T01:00:00Z");

    const destPath = join(dir, "backup.db");
    vacuumSnapshot(srcPath, destPath);
    srcDb.close();

    const destDb = new Database(destPath, { readonly: true });
    try {
      const rows = destDb.query("SELECT * FROM reports ORDER BY id").all() as { body: string }[];
      expect(rows).toHaveLength(2);
      expect(rows[1].body).toBe("world");
    } finally {
      destDb.close();
    }
  });

  test("isRcloneRemote detects remote paths", async () => {
    const { isRcloneRemote } = await import("./archive-backup");

    expect(isRcloneRemote("gdrive:worqload/archive.db")).toBe(true);
    expect(isRcloneRemote("s3:bucket/archive.db")).toBe(true);
    expect(isRcloneRemote("/tmp/backup.db")).toBe(false);
    expect(isRcloneRemote("./backup.db")).toBe(false);
    expect(isRcloneRemote("C:\\backup.db")).toBe(false);
  });
});
