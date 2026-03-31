import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { appendServerLog, loadRecentServerLogs, summarizeServerLogs } from "./server-log";
import type { ServerLogEntry } from "./server-log";

function tmpPath(): string {
  return join(tmpdir(), `worqload-server-log-test-${crypto.randomUUID()}.jsonl`);
}

test("loadRecentServerLogs returns empty array when file does not exist", async () => {
  const path = tmpPath();
  const logs = await loadRecentServerLogs(60_000, path);
  expect(logs).toEqual([]);
});

test("appendServerLog writes entry and loadRecentServerLogs reads it", async () => {
  const path = tmpPath();
  await appendServerLog({ method: "GET", path: "/api/tasks", statusCode: 200, durationMs: 12 }, path);

  const logs = await loadRecentServerLogs(60_000, path);
  expect(logs).toHaveLength(1);
  expect(logs[0].method).toBe("GET");
  expect(logs[0].path).toBe("/api/tasks");
  expect(logs[0].statusCode).toBe(200);
  expect(logs[0].durationMs).toBe(12);
  expect(logs[0].timestamp).toBeTruthy();
});

test("multiple entries are appended and read back", async () => {
  const path = tmpPath();
  await appendServerLog({ method: "GET", path: "/api/tasks", statusCode: 200, durationMs: 5 }, path);
  await appendServerLog({ method: "POST", path: "/api/tasks", statusCode: 201, durationMs: 30 }, path);
  await appendServerLog({ method: "GET", path: "/api/missions", statusCode: 500, durationMs: 150 }, path);

  const logs = await loadRecentServerLogs(60_000, path);
  expect(logs).toHaveLength(3);
});

test("loadRecentServerLogs filters by maxAgeMs", async () => {
  const path = tmpPath();
  const oldTimestamp = new Date(Date.now() - 120_000).toISOString();
  const recentTimestamp = new Date().toISOString();

  // Write entries manually to control timestamps
  const old: ServerLogEntry = { method: "GET", path: "/old", statusCode: 200, durationMs: 1, timestamp: oldTimestamp };
  const recent: ServerLogEntry = { method: "GET", path: "/recent", statusCode: 200, durationMs: 1, timestamp: recentTimestamp };
  await Bun.write(path, JSON.stringify(old) + "\n" + JSON.stringify(recent) + "\n");

  const logs = await loadRecentServerLogs(60_000, path);
  expect(logs).toHaveLength(1);
  expect(logs[0].path).toBe("/recent");
});

test("summarizeServerLogs returns stats", async () => {
  const now = new Date().toISOString();
  const logs: ServerLogEntry[] = [
    { method: "GET", path: "/api/tasks", statusCode: 200, durationMs: 10, timestamp: now },
    { method: "GET", path: "/api/tasks", statusCode: 200, durationMs: 20, timestamp: now },
    { method: "POST", path: "/api/tasks", statusCode: 201, durationMs: 50, timestamp: now },
    { method: "GET", path: "/api/missions", statusCode: 500, durationMs: 200, timestamp: now },
    { method: "GET", path: "/api/mission-runners", statusCode: 500, durationMs: 300, timestamp: now },
  ];

  const summary = summarizeServerLogs(logs);
  expect(summary.totalRequests).toBe(5);
  expect(summary.errorCount).toBe(2);
  expect(summary.errorRate).toBeCloseTo(0.4);
  expect(summary.avgDurationMs).toBe(116);
  expect(summary.errorPaths).toContain("/api/missions");
  expect(summary.errorPaths).toContain("/api/mission-runners");
});

test("summarizeServerLogs handles empty logs", () => {
  const summary = summarizeServerLogs([]);
  expect(summary.totalRequests).toBe(0);
  expect(summary.errorCount).toBe(0);
  expect(summary.errorRate).toBe(0);
  expect(summary.avgDurationMs).toBe(0);
  expect(summary.errorPaths).toEqual([]);
});
