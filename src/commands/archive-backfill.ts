import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { openArchiveDb, insertReport, insertFeedback, upsertSession, defaultArchiveDbPath } from "../archive-store";
import { listAllFiles } from "../file-store";
import { loadSessionMeta } from "../session";
import { realWorktreeOps } from "../worktree";

export async function archiveBackfill(args: string[]): Promise<void> {
  const repoDir = process.cwd();
  const sessionsDir = join(repoDir, ".worqload", "sessions");
  const dbPath = args[0] ?? defaultArchiveDbPath();

  const repoIdentifier = (await realWorktreeOps.gitRemoteUrl(repoDir).catch(() => null)) ?? repoDir;

  let sessionDirs: string[];
  try {
    sessionDirs = await readdir(sessionsDir);
  } catch {
    console.error(`No sessions directory found at ${sessionsDir}`);
    process.exit(1);
  }

  const db = openArchiveDb(dbPath);
  let reportCount = 0;
  let feedbackCount = 0;

  try {
    for (const sessionId of sessionDirs) {
      const sessionPath = join(sessionsDir, sessionId);
      const s = await stat(sessionPath).catch(() => null);
      if (!s?.isDirectory()) continue;

      const meta = await loadSessionMeta(sessionId, sessionsDir);
      if (meta) {
        upsertSession(db, {
          sessionId,
          repo: repoIdentifier,
          initialPrompt: meta.prompt,
          createdAt: meta.createdAt,
        });
      }

      const reportsDir = join(sessionPath, "reports");
      const reports = await listAllFiles(reportsDir);
      for (const r of reports) {
        const fileStat = await stat(r.path).catch(() => null);
        insertReport(db, {
          repo: repoIdentifier,
          sessionId,
          filename: r.filename,
          slug: r.filename.replace(/^\d+-/, "").replace(/\.md$/, ""),
          body: r.content,
          replyTo: r.meta?.replyTo ?? null,
          anchorPath: r.meta?.anchor?.path ?? null,
          anchorLineStart: r.meta?.anchor?.lineStart ?? null,
          anchorLineEnd: r.meta?.anchor?.lineEnd ?? null,
          createdAt: fileStat ? fileStat.mtime.toISOString() : new Date().toISOString(),
        });
        reportCount++;
      }

      for (const feedbackDir of [join(sessionPath, "feedback", "inbox"), join(sessionPath, "feedback", "read")]) {
        const items = await listAllFiles(feedbackDir);
        for (const f of items) {
          const fileStat = await stat(f.path).catch(() => null);
          insertFeedback(db, {
            repo: repoIdentifier,
            sessionId,
            filename: f.filename,
            body: f.content,
            anchorPath: f.meta?.anchor?.path ?? null,
            anchorLineStart: f.meta?.anchor?.lineStart ?? null,
            anchorLineEnd: f.meta?.anchor?.lineEnd ?? null,
            createdAt: fileStat ? fileStat.mtime.toISOString() : new Date().toISOString(),
          });
          feedbackCount++;
        }
      }
    }
  } finally {
    db.close();
  }

  console.log(`Backfilled ${reportCount} reports and ${feedbackCount} feedback to ${dbPath}`);
}
