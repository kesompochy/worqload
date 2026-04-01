import { EntityStore } from "./utils/entity-store";

const DEFAULT_REPORTS_PATH = ".worqload/reports.json";

export type ReportStatus = "unread" | "reading" | "read" | "archived";

export interface Report {
  id: string;
  title: string;
  content: string;
  status: ReportStatus;
  createdBy: string;
  createdAt: string;
  taskId?: string;
}

const store = new EntityStore<Report>(DEFAULT_REPORTS_PATH, "Report");

export async function loadReports(path?: string): Promise<Report[]> {
  return store.load(path);
}

export async function saveReports(reports: Report[], path?: string): Promise<void> {
  await store.save(reports, path);
}

export interface AddReportOptions {
  taskId?: string;
  path?: string;
}

export async function addReport(title: string, content: string, createdBy: string, pathOrOptions?: string | AddReportOptions): Promise<Report> {
  const resolvedPath = typeof pathOrOptions === "string" ? pathOrOptions : pathOrOptions?.path;
  const taskId = typeof pathOrOptions === "string" ? undefined : pathOrOptions.taskId;
  const report: Report = {
    id: crypto.randomUUID(),
    title,
    content,
    status: "unread",
    createdBy,
    createdAt: new Date().toISOString(),
    ...(taskId ? { taskId } : {}),
  };
  return store.add(report, resolvedPath);
}

export async function updateReportStatus(id: string, status: ReportStatus, path?: string): Promise<void> {
  await store.update(id, { status }, path);
}

export async function removeReport(id: string, path?: string): Promise<void> {
  await store.remove(id, path);
}

const VACUOUS_PATTERNS: RegExp[] = [
  // Japanese: explicitly claiming no work / no changes
  /^変化\s*なし$/,
  /^アクション\s*なし$/,
  /^特に?\s*なし$/,
  /^問題\s*なし$/,
  /^対応\s*不要$/,
  /^実行\s*なし$/,
  /^該当\s*なし$/,
  /^なし$/,
  /^（ログなし）$/,
  /^確認\s*済み?$/,
  // English: explicitly claiming no work / no changes
  /^no\s+changes?$/i,
  /^nothing\s+to\s+do$/i,
  /^no\s+action\s+(needed|required|taken)$/i,
  /^no\s+issues?$/i,
  /^no\s+updates?$/i,
  /^n\/?a$/i,
  /^none$/i,
  /^done$/i,
  /^completed?$/i,
  /^ok$/i,
];

export function isVacuousContent(content: string): boolean {
  const normalized = content.trim().replace(/[.。！!]+$/, "").trim();
  if (normalized.length === 0) return true;
  return VACUOUS_PATTERNS.some(pattern => pattern.test(normalized));
}
