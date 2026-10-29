import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function defaultArchiveDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "worqload", "archive.db");
}

const SCHEMA = `
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

-- One row per draft that went through the polish fork. rounds is a JSON
-- array of the fork's output per round. result is the stored text for
-- stored and cancelled, and the fork's reason for withdrawn and returned.
CREATE TABLE IF NOT EXISTS polishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  slug TEXT NOT NULL,
  draft TEXT NOT NULL,
  rounds TEXT NOT NULL,
  outcome TEXT NOT NULL,
  result TEXT NOT NULL,
  stored_filename TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  initial_prompt TEXT,
  created_at TEXT NOT NULL
);
`;

export function openArchiveDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  return db;
}

export interface ReportRow {
  repo: string;
  sessionId: string;
  filename: string;
  slug: string | null;
  body: string;
  replyTo: string | null;
  anchorPath: string | null;
  anchorLineStart: number | null;
  anchorLineEnd: number | null;
  createdAt: string;
}

export interface FeedbackRow {
  repo: string;
  sessionId: string;
  filename: string;
  body: string;
  anchorPath: string | null;
  anchorLineStart: number | null;
  anchorLineEnd: number | null;
  createdAt: string;
}

export function insertReport(db: Database, row: ReportRow): void {
  db.query(`
    INSERT OR IGNORE INTO reports
      (repo, session_id, filename, slug, body, reply_to, anchor_path, anchor_line_start, anchor_line_end, created_at)
    VALUES
      ($repo, $sessionId, $filename, $slug, $body, $replyTo, $anchorPath, $anchorLineStart, $anchorLineEnd, $createdAt)
  `).run({
    $repo: row.repo,
    $sessionId: row.sessionId,
    $filename: row.filename,
    $slug: row.slug,
    $body: row.body,
    $replyTo: row.replyTo,
    $anchorPath: row.anchorPath,
    $anchorLineStart: row.anchorLineStart,
    $anchorLineEnd: row.anchorLineEnd,
    $createdAt: row.createdAt,
  });
}

export function insertFeedback(db: Database, row: FeedbackRow): void {
  db.query(`
    INSERT OR IGNORE INTO feedback
      (repo, session_id, filename, body, anchor_path, anchor_line_start, anchor_line_end, created_at)
    VALUES
      ($repo, $sessionId, $filename, $body, $anchorPath, $anchorLineStart, $anchorLineEnd, $createdAt)
  `).run({
    $repo: row.repo,
    $sessionId: row.sessionId,
    $filename: row.filename,
    $body: row.body,
    $anchorPath: row.anchorPath,
    $anchorLineStart: row.anchorLineStart,
    $anchorLineEnd: row.anchorLineEnd,
    $createdAt: row.createdAt,
  });
}

export interface PolishRow {
  repo: string;
  sessionId: string;
  kind: "report" | "escalation";
  slug: string;
  draft: string;
  rounds: string[];
  // cancelled: the writer cancelled the escalation while the fork ran.
  outcome: "stored" | "withdrawn" | "returned" | "cancelled";
  result: string;
  storedFilename: string | null;
  createdAt: string;
}

export function insertPolish(db: Database, row: PolishRow): void {
  db.query(`
    INSERT INTO polishes
      (repo, session_id, kind, slug, draft, rounds, outcome, result, stored_filename, created_at)
    VALUES
      ($repo, $sessionId, $kind, $slug, $draft, $rounds, $outcome, $result, $storedFilename, $createdAt)
  `).run({
    $repo: row.repo,
    $sessionId: row.sessionId,
    $kind: row.kind,
    $slug: row.slug,
    $draft: row.draft,
    $rounds: JSON.stringify(row.rounds),
    $outcome: row.outcome,
    $result: row.result,
    $storedFilename: row.storedFilename,
    $createdAt: row.createdAt,
  });
}

export function listPolishes(db: Database, sessionId: string): PolishRow[] {
  const rows = db.query("SELECT * FROM polishes WHERE session_id = $sessionId ORDER BY id").all({ $sessionId: sessionId }) as {
    repo: string;
    session_id: string;
    kind: PolishRow["kind"];
    slug: string;
    draft: string;
    rounds: string;
    outcome: PolishRow["outcome"];
    result: string;
    stored_filename: string | null;
    created_at: string;
  }[];
  return rows.map(r => ({
    repo: r.repo,
    sessionId: r.session_id,
    kind: r.kind,
    slug: r.slug,
    draft: r.draft,
    rounds: JSON.parse(r.rounds) as string[],
    outcome: r.outcome,
    result: r.result,
    storedFilename: r.stored_filename,
    createdAt: r.created_at,
  }));
}

export interface SessionRow {
  sessionId: string;
  repo: string;
  initialPrompt: string | null;
  createdAt: string;
}

export function upsertSession(db: Database, row: SessionRow): void {
  db.query(`
    INSERT OR IGNORE INTO sessions (session_id, repo, initial_prompt, created_at)
    VALUES ($sessionId, $repo, $initialPrompt, $createdAt)
  `).run({
    $sessionId: row.sessionId,
    $repo: row.repo,
    $initialPrompt: row.initialPrompt,
    $createdAt: row.createdAt,
  });
}

export interface SessionSummary {
  sessionId: string;
  repo: string;
  latestAt: string;
  reportCount: number;
  feedbackCount: number;
  initialPrompt: string | null;
}

export function listAllReports(db: Database, filter?: { repo?: string }): ReportRow[] {
  const where = filter?.repo ? "WHERE repo = $repo" : "";
  const rows = db.query(`SELECT * FROM reports ${where} ORDER BY created_at DESC`).all(
    filter?.repo ? { $repo: filter.repo } : {},
  ) as ReportQueryRow[];
  return rows.map(r => ({
    repo: r.repo,
    sessionId: r.session_id,
    filename: r.filename,
    slug: r.slug,
    body: r.body,
    replyTo: r.reply_to,
    anchorPath: r.anchor_path,
    anchorLineStart: r.anchor_line_start,
    anchorLineEnd: r.anchor_line_end,
    createdAt: r.created_at,
  }));
}

export function listAllFeedback(db: Database, filter?: { repo?: string }): FeedbackRow[] {
  const where = filter?.repo ? "WHERE repo = $repo" : "";
  const rows = db.query(`SELECT * FROM feedback ${where} ORDER BY created_at DESC`).all(
    filter?.repo ? { $repo: filter.repo } : {},
  ) as FeedbackQueryRow[];
  return rows.map(r => ({
    repo: r.repo,
    sessionId: r.session_id,
    filename: r.filename,
    body: r.body,
    anchorPath: r.anchor_path,
    anchorLineStart: r.anchor_line_start,
    anchorLineEnd: r.anchor_line_end,
    createdAt: r.created_at,
  }));
}

export function listAllSessions(db: Database, filter?: { repo?: string }): SessionSummary[] {
  const where = filter?.repo ? "WHERE repo = $repo" : "";
  const rows = db.query(`
    SELECT agg.session_id, agg.repo, agg.latest_at, agg.report_count, agg.feedback_count, s.initial_prompt
    FROM (
      SELECT session_id, repo, MAX(latest) AS latest_at, SUM(rc) AS report_count, SUM(fc) AS feedback_count
      FROM (
        SELECT session_id, repo, created_at AS latest, 1 AS rc, 0 AS fc FROM reports ${where}
        UNION ALL
        SELECT session_id, repo, created_at AS latest, 0 AS rc, 1 AS fc FROM feedback ${where}
      )
      GROUP BY session_id
    ) agg
    LEFT JOIN sessions s ON s.session_id = agg.session_id
    ORDER BY agg.latest_at DESC
  `).all(filter?.repo ? { $repo: filter.repo } : {}) as {
    session_id: string;
    repo: string;
    latest_at: string;
    report_count: number;
    feedback_count: number;
    initial_prompt: string | null;
  }[];
  return rows.map(r => ({
    sessionId: r.session_id,
    repo: r.repo,
    latestAt: r.latest_at,
    reportCount: r.report_count,
    feedbackCount: r.feedback_count,
    initialPrompt: r.initial_prompt,
  }));
}

interface ReportQueryRow {
  id: number;
  repo: string;
  session_id: string;
  filename: string;
  slug: string | null;
  body: string;
  reply_to: string | null;
  anchor_path: string | null;
  anchor_line_start: number | null;
  anchor_line_end: number | null;
  created_at: string;
}

interface FeedbackQueryRow {
  id: number;
  repo: string;
  session_id: string;
  filename: string;
  body: string;
  anchor_path: string | null;
  anchor_line_start: number | null;
  anchor_line_end: number | null;
  created_at: string;
}

export function searchReports(db: Database, query: string): ReportRow[] {
  const rows = db.query(
    "SELECT * FROM reports WHERE body LIKE $pattern ORDER BY created_at DESC"
  ).all({ $pattern: `%${query}%` }) as ReportQueryRow[];
  return rows.map(r => ({
    repo: r.repo,
    sessionId: r.session_id,
    filename: r.filename,
    slug: r.slug,
    body: r.body,
    replyTo: r.reply_to,
    anchorPath: r.anchor_path,
    anchorLineStart: r.anchor_line_start,
    anchorLineEnd: r.anchor_line_end,
    createdAt: r.created_at,
  }));
}

export function searchFeedback(db: Database, query: string): FeedbackRow[] {
  const rows = db.query(
    "SELECT * FROM feedback WHERE body LIKE $pattern ORDER BY created_at DESC"
  ).all({ $pattern: `%${query}%` }) as FeedbackQueryRow[];
  return rows.map(r => ({
    repo: r.repo,
    sessionId: r.session_id,
    filename: r.filename,
    body: r.body,
    anchorPath: r.anchor_path,
    anchorLineStart: r.anchor_line_start,
    anchorLineEnd: r.anchor_line_end,
    createdAt: r.created_at,
  }));
}

export function listReports(db: Database, sessionId: string): ReportRow[] {
  const rows = db.query("SELECT * FROM reports WHERE session_id = $sessionId ORDER BY filename").all({
    $sessionId: sessionId,
  }) as ReportQueryRow[];
  return rows.map(r => ({
    repo: r.repo,
    sessionId: r.session_id,
    filename: r.filename,
    slug: r.slug,
    body: r.body,
    replyTo: r.reply_to,
    anchorPath: r.anchor_path,
    anchorLineStart: r.anchor_line_start,
    anchorLineEnd: r.anchor_line_end,
    createdAt: r.created_at,
  }));
}

export function listFeedback(db: Database, sessionId: string): FeedbackRow[] {
  const rows = db.query("SELECT * FROM feedback WHERE session_id = $sessionId ORDER BY filename").all({
    $sessionId: sessionId,
  }) as FeedbackQueryRow[];
  return rows.map(r => ({
    repo: r.repo,
    sessionId: r.session_id,
    filename: r.filename,
    body: r.body,
    anchorPath: r.anchor_path,
    anchorLineStart: r.anchor_line_start,
    anchorLineEnd: r.anchor_line_end,
    createdAt: r.created_at,
  }));
}
