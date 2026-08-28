import { Database } from "bun:sqlite";
import { defaultArchiveDbPath } from "../archive-store";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function isRcloneRemote(path: string): boolean {
  if (/^[A-Za-z]:\\/.test(path)) return false;
  return /^[A-Za-z0-9_-]+:/.test(path);
}

export function vacuumSnapshot(srcDbPath: string, destPath: string): void {
  const db = new Database(srcDbPath, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

export async function archiveBackup(args: string[]): Promise<void> {
  const dest = args[0];
  if (!dest) {
    console.error("Usage: worqload archive-backup <destination>");
    console.error("  destination: local path or rclone remote (e.g. gdrive:worqload/archive.db)");
    process.exit(2);
  }

  const dbPath = defaultArchiveDbPath();
  if (!existsSync(dbPath)) {
    console.error(`Archive database not found: ${dbPath}`);
    process.exit(1);
  }

  const remote = isRcloneRemote(dest);
  const snapshotPath = remote
    ? join(tmpdir(), `worqload-backup-${Date.now()}.db`)
    : dest;

  try {
    vacuumSnapshot(dbPath, snapshotPath);
    if (!remote) {
      console.log(`Backup saved to ${dest}`);
      return;
    }

    const result = spawnSync("rclone", ["copyto", snapshotPath, dest], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
    console.log(`Backup uploaded to ${dest}`);
  } finally {
    if (remote) {
      try { unlinkSync(snapshotPath); } catch {}
    }
  }
}
