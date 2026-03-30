import { loadJsonFile, saveJsonFile } from "./utils/json-store";

const DEFAULT_REPORTS_PATH = ".worqload/reports.json";

export type ReportStatus = "unread" | "reading" | "read" | "archived";

export interface Report {
  id: string;
  title: string;
  content: string;
  status: ReportStatus;
  createdBy: string;
  createdAt: string;
}

export async function loadReports(path: string = DEFAULT_REPORTS_PATH): Promise<Report[]> {
  return loadJsonFile<Report[]>(path, []);
}

export async function saveReports(reports: Report[], path: string = DEFAULT_REPORTS_PATH): Promise<void> {
  await saveJsonFile(path, reports);
}

export async function addReport(title: string, content: string, createdBy: string, path: string = DEFAULT_REPORTS_PATH): Promise<Report> {
  const report: Report = {
    id: crypto.randomUUID(),
    title,
    content,
    status: "unread",
    createdBy,
    createdAt: new Date().toISOString(),
  };
  const reports = await loadReports(path);
  reports.push(report);
  await saveReports(reports, path);
  return report;
}

export async function updateReportStatus(id: string, status: ReportStatus, path: string = DEFAULT_REPORTS_PATH): Promise<void> {
  const reports = await loadReports(path);
  const report = reports.find(r => r.id === id || r.id.startsWith(id));
  if (!report) throw new Error(`Report not found: ${id}`);
  report.status = status;
  await saveReports(reports, path);
}

export async function removeReport(id: string, path: string = DEFAULT_REPORTS_PATH): Promise<void> {
  const reports = await loadReports(path);
  const filtered = reports.filter(r => r.id !== id && !r.id.startsWith(id));
  if (filtered.length === reports.length) throw new Error(`Report not found: ${id}`);
  await saveReports(filtered, path);
}
