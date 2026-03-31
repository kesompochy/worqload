import { appendFile } from "node:fs/promises";

const DEFAULT_PATH = ".worqload/server-log.jsonl";

export interface ServerLogEntry {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  timestamp: string;
}

export interface ServerLogSummary {
  totalRequests: number;
  errorCount: number;
  errorRate: number;
  avgDurationMs: number;
  errorPaths: string[];
}

export async function appendServerLog(
  entry: Omit<ServerLogEntry, "timestamp"> & { timestamp?: string },
  path: string = DEFAULT_PATH,
): Promise<void> {
  const full: ServerLogEntry = {
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  };
  const { dirname } = await import("path");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(full) + "\n");
}

export async function loadRecentServerLogs(
  maxAgeMs: number,
  path: string = DEFAULT_PATH,
): Promise<ServerLogEntry[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];

  const text = await file.text();
  const cutoff = Date.now() - maxAgeMs;
  const entries: ServerLogEntry[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry: ServerLogEntry = JSON.parse(line);
    if (new Date(entry.timestamp).getTime() >= cutoff) {
      entries.push(entry);
    }
  }
  return entries;
}

export function summarizeServerLogs(logs: ServerLogEntry[]): ServerLogSummary {
  if (logs.length === 0) {
    return { totalRequests: 0, errorCount: 0, errorRate: 0, avgDurationMs: 0, errorPaths: [] };
  }

  const errors = logs.filter(l => l.statusCode >= 500);
  const errorPathSet = new Set(errors.map(l => l.path));
  const totalDuration = logs.reduce((sum, l) => sum + l.durationMs, 0);

  return {
    totalRequests: logs.length,
    errorCount: errors.length,
    errorRate: errors.length / logs.length,
    avgDurationMs: Math.round(totalDuration / logs.length),
    errorPaths: [...errorPathSet],
  };
}
