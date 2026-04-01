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

export async function loadReports(path: string = DEFAULT_REPORTS_PATH): Promise<Report[]> {
  return store.load(path);
}

export async function saveReports(reports: Report[], path: string = DEFAULT_REPORTS_PATH): Promise<void> {
  await store.save(reports, path);
}

export interface AddReportOptions {
  taskId?: string;
  path?: string;
}

export async function addReport(title: string, content: string, createdBy: string, pathOrOptions: string | AddReportOptions = DEFAULT_REPORTS_PATH): Promise<Report> {
  const resolvedPath = typeof pathOrOptions === "string" ? pathOrOptions : (pathOrOptions.path ?? DEFAULT_REPORTS_PATH);
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

export async function updateReportStatus(id: string, status: ReportStatus, path: string = DEFAULT_REPORTS_PATH): Promise<void> {
  await store.update(id, { status }, path);
}

export async function removeReport(id: string, path: string = DEFAULT_REPORTS_PATH): Promise<void> {
  await store.remove(id, path);
}
