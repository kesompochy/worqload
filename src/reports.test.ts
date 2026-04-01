import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadReports,
  saveReports,
  addReport,
  updateReportStatus,
  removeReport,
  isVacuousContent,
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

describe("report category", () => {
  test("addReport defaults category to internal when path string is passed", async () => {
    const path = tmpReportsPath();
    const report = await addReport("内部監査", "監査ログ", "agent-1", path);
    expect(report.category).toBe("internal");
  });

  test("addReport defaults category to internal when options without category", async () => {
    const path = tmpReportsPath();
    const report = await addReport("内部監査", "監査ログ", "agent-1", { path });
    expect(report.category).toBe("internal");
  });

  test("addReport accepts category in options", async () => {
    const path = tmpReportsPath();
    const report = await addReport("人間向けレポート", "読んでください", "agent-1", { path, category: "human" });
    expect(report.category).toBe("human");
  });

  test("addReport accepts internal category explicitly", async () => {
    const path = tmpReportsPath();
    const report = await addReport("内部レポート", "内部用", "agent-1", { path, category: "internal" });
    expect(report.category).toBe("internal");
  });

  test("category is persisted through save/load", async () => {
    const path = tmpReportsPath();
    await addReport("人間向け", "内容", "agent-1", { path, category: "human" });
    await addReport("内部用", "内容", "agent-1", { path, category: "internal" });

    const reports = await loadReports(path);
    expect(reports).toHaveLength(2);
    expect(reports[0].category).toBe("human");
    expect(reports[1].category).toBe("internal");
  });

  test("legacy reports without category are treated as internal", async () => {
    const path = tmpReportsPath();
    const legacyReport: Report = {
      id: "legacy-id",
      title: "旧レポート",
      content: "旧形式",
      status: "unread",
      createdBy: "agent-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await saveReports([legacyReport], path);

    const reports = await loadReports(path);
    expect(reports[0].category).toBeUndefined();
  });
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

describe("isVacuousContent", () => {
  test("detects empty and whitespace-only content", () => {
    expect(isVacuousContent("")).toBe(true);
    expect(isVacuousContent("  ")).toBe(true);
    expect(isVacuousContent("\n")).toBe(true);
  });

  test("detects Japanese vacuous phrases", () => {
    expect(isVacuousContent("変化なし")).toBe(true);
    expect(isVacuousContent("アクションなし")).toBe(true);
    expect(isVacuousContent("特になし")).toBe(true);
    expect(isVacuousContent("特になし")).toBe(true);
    expect(isVacuousContent("問題なし")).toBe(true);
    expect(isVacuousContent("対応不要")).toBe(true);
    expect(isVacuousContent("実行なし")).toBe(true);
    expect(isVacuousContent("該当なし")).toBe(true);
    expect(isVacuousContent("なし")).toBe(true);
    expect(isVacuousContent("（ログなし）")).toBe(true);
    expect(isVacuousContent("確認済み")).toBe(true);
    expect(isVacuousContent("確認済")).toBe(true);
  });

  test("detects English vacuous phrases", () => {
    expect(isVacuousContent("no changes")).toBe(true);
    expect(isVacuousContent("No Change")).toBe(true);
    expect(isVacuousContent("nothing to do")).toBe(true);
    expect(isVacuousContent("no action needed")).toBe(true);
    expect(isVacuousContent("no action required")).toBe(true);
    expect(isVacuousContent("no action taken")).toBe(true);
    expect(isVacuousContent("no issues")).toBe(true);
    expect(isVacuousContent("no issue")).toBe(true);
    expect(isVacuousContent("no updates")).toBe(true);
    expect(isVacuousContent("N/A")).toBe(true);
    expect(isVacuousContent("n/a")).toBe(true);
    expect(isVacuousContent("none")).toBe(true);
  });

  test("strips trailing punctuation before matching", () => {
    expect(isVacuousContent("変化なし。")).toBe(true);
    expect(isVacuousContent("no changes.")).toBe(true);
    expect(isVacuousContent("none!")).toBe(true);
    expect(isVacuousContent("問題なし！")).toBe(true);
  });

  test("strips surrounding whitespace before matching", () => {
    expect(isVacuousContent("  変化なし  ")).toBe(true);
    expect(isVacuousContent("  no changes  ")).toBe(true);
  });

  test("does not flag substantive content", () => {
    expect(isVacuousContent("Implemented the new feature with full test coverage")).toBe(false);
    expect(isVacuousContent("テスト追加とリファクタリングを実施")).toBe(false);
    expect(isVacuousContent("Fixed bug in authentication flow")).toBe(false);
    expect(isVacuousContent("変化なしの理由を調査した結果、設定ファイルに問題があった")).toBe(false);
  });

  test("does not flag system markers", () => {
    expect(isVacuousContent("[RETRY] 1/2 - exit code 1")).toBe(false);
    expect(isVacuousContent("[TIMEOUT] Spawn timed out after 300000ms")).toBe(false);
    expect(isVacuousContent("[FAILED] exit code 1")).toBe(false);
  });
});
