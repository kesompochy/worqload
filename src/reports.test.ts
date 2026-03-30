import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadReports,
  saveReports,
  addReport,
  updateReportStatus,
  removeReport,
} from "./reports";
import type { Report } from "./reports";

function tmpReportsPath(): string {
  return join(tmpdir(), `worqload-reports-test-${crypto.randomUUID()}.json`);
}

test("loadReports returns empty array when file does not exist", async () => {
  const path = tmpReportsPath();
  expect(await loadReports(path)).toEqual([]);
});

test("saveReports then loadReports round-trips", async () => {
  const path = tmpReportsPath();
  const report: Report = {
    id: "test-id",
    title: "テストレポート",
    content: "レポート内容",
    status: "unread",
    createdBy: "spawn-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  await saveReports([report], path);
  const loaded = await loadReports(path);
  expect(loaded).toEqual([report]);
});

test("addReport creates an unread report", async () => {
  const path = tmpReportsPath();
  const report = await addReport("タスク完了報告", "実装が完了しました", "agent-1", path);

  expect(report.title).toBe("タスク完了報告");
  expect(report.content).toBe("実装が完了しました");
  expect(report.createdBy).toBe("agent-1");
  expect(report.status).toBe("unread");
  expect(report.id).toBeTruthy();
  expect(report.createdAt).toBeTruthy();

  const reports = await loadReports(path);
  expect(reports).toHaveLength(1);
  expect(reports[0].id).toBe(report.id);
});

test("updateReportStatus changes status", async () => {
  const path = tmpReportsPath();
  const report = await addReport("状態変更テスト", "内容", "agent-1", path);

  await updateReportStatus(report.id, "read", path);

  const reports = await loadReports(path);
  expect(reports[0].status).toBe("read");
});

test("updateReportStatus throws for unknown id", async () => {
  const path = tmpReportsPath();
  await expect(updateReportStatus("nonexistent", "read", path)).rejects.toThrow("Report not found");
});

test("removeReport deletes the report", async () => {
  const path = tmpReportsPath();
  const report = await addReport("削除テスト", "内容", "agent-1", path);

  await removeReport(report.id, path);

  const reports = await loadReports(path);
  expect(reports).toHaveLength(0);
});

test("removeReport throws for unknown id", async () => {
  const path = tmpReportsPath();
  await expect(removeReport("nonexistent", path)).rejects.toThrow("Report not found");
});

test("multiple reports are tracked independently", async () => {
  const path = tmpReportsPath();
  const r1 = await addReport("レポートA", "内容A", "agent-1", path);
  const r2 = await addReport("レポートB", "内容B", "agent-2", path);

  await updateReportStatus(r1.id, "archived", path);

  const reports = await loadReports(path);
  expect(reports).toHaveLength(2);
  expect(reports.find(r => r.id === r1.id)!.status).toBe("archived");
  expect(reports.find(r => r.id === r2.id)!.status).toBe("unread");
});
