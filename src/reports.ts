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
}

const store = new EntityStore<Report>(DEFAULT_REPORTS_PATH, "Report");

export async function loadReports(path: string = DEFAULT_REPORTS_PATH): Promise<Report[]> {
  return store.load(path);
}

export async function saveReports(reports: Report[], path: string = DEFAULT_REPORTS_PATH): Promise<void> {
  await store.save(reports, path);
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
  return store.add(report, path);
}

export async function updateReportStatus(id: string, status: ReportStatus, path: string = DEFAULT_REPORTS_PATH): Promise<void> {
  await store.update(id, { status }, path);
}

export async function removeReport(id: string, path: string = DEFAULT_REPORTS_PATH): Promise<void> {
  await store.remove(id, path);
}
