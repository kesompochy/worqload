import type { TaskQueue } from "../queue";
import type { Task } from "../task";
import { SHORT_ID_LENGTH } from "../task";
import { loadReports, isVacuousContent, type Report } from "../reports";
import { loadRunnerStatesUnlocked, type RunnerState } from "../mission-runner-state";
import { detectStuckTasks, detectCompletedFeedbackTasks, type StuckTask, type SuspiciousTask, type CompletedFeedbackTask } from "./iterate";

export interface StaleRunner {
  runnerId: string;
  missionName: string;
  lastHeartbeat: string;
  staleSinceMinutes: number;
}

export interface AuditSummary {
  totalActive: number;
  byStatus: Record<string, number>;
  totalStuck: number;
  totalSuspicious: number;
  totalMissingHumanReports: number;
  totalStaleRunners: number;
  healthy: boolean;
}

export interface AuditResult {
  stuckTasks: StuckTask[];
  suspiciousTasks: SuspiciousTask[];
  missingHumanReports: CompletedFeedbackTask[];
  staleRunners: StaleRunner[];
  summary: AuditSummary;
}

export interface AuditOptions {
  reportsPath?: string;
  runnersPath?: string;
  stuckThresholdMinutes?: number;
  staleRunnerThresholdMinutes?: number;
}

const DEFAULT_STALE_RUNNER_THRESHOLD_MINUTES = 5;
const MIN_ACT_CONTENT_LENGTH = 10;

function auditCompletions(tasks: Task[], reports: Report[]): SuspiciousTask[] {
  const doneTasks = tasks.filter(t => t.status === "done");
  const suspicious: SuspiciousTask[] = [];

  for (const task of doneTasks) {
    const reasons: string[] = [];

    const actLogs = task.logs.filter(l => l.phase === "act");
    if (actLogs.length === 0) {
      reasons.push("no act log");
    } else if (!actLogs.some(l => l.content.length >= MIN_ACT_CONTENT_LENGTH)) {
      reasons.push("act log lacks substance");
    } else {
      const substantiveLogs = actLogs.filter(l =>
        !l.content.startsWith("[RETRY]") && !l.content.startsWith("[FAILED]") && !l.content.startsWith("[TIMEOUT]"),
      );
      if (substantiveLogs.length > 0 && substantiveLogs.every(l => isVacuousContent(l.content))) {
        reasons.push("act log is vacuous");
      }
    }

    const shortId = task.id.slice(0, SHORT_ID_LENGTH);
    const matchingReport = reports.find(
      r => r.content.includes(task.id) || r.content.includes(shortId)
        || r.title.includes(task.id) || r.title.includes(shortId),
    );
    if (!matchingReport) {
      reasons.push("no report found");
    } else if (matchingReport.content.length < 50 || isVacuousContent(matchingReport.content)) {
      reasons.push("report lacks substance");
    }

    if (reasons.length > 0) {
      suspicious.push({ taskId: task.id, title: task.title, reasons });
    }
  }
  return suspicious;
}

function detectStaleRunners(runners: RunnerState[], thresholdMinutes: number): StaleRunner[] {
  const now = Date.now();
  const thresholdMs = thresholdMinutes * 60 * 1000;
  const stale: StaleRunner[] = [];

  for (const runner of runners) {
    if (runner.status === "stopped") continue;
    const elapsed = now - new Date(runner.lastHeartbeat).getTime();
    if (elapsed > thresholdMs) {
      stale.push({
        runnerId: runner.id,
        missionName: runner.missionName,
        lastHeartbeat: runner.lastHeartbeat,
        staleSinceMinutes: Math.floor(elapsed / 60000),
      });
    }
  }
  return stale;
}

export async function runAudit(queue: TaskQueue, options: AuditOptions = {}): Promise<AuditResult> {
  const allTasks = queue.list();
  const activeTasks = allTasks.filter(t => t.status !== "done" && t.status !== "failed");

  const stuckTasks = detectStuckTasks(activeTasks, options.stuckThresholdMinutes);

  const reports = options.reportsPath
    ? await loadReports(options.reportsPath).catch(() => [] as Report[])
    : [];
  const suspiciousTasks = auditCompletions(allTasks, reports);

  const missingHumanReports = await detectCompletedFeedbackTasks(queue, { reportsPath: options.reportsPath });

  const runners = options.runnersPath
    ? await loadRunnerStatesUnlocked(options.runnersPath).catch(() => [] as RunnerState[])
    : [];
  const staleRunnerThreshold = options.staleRunnerThresholdMinutes ?? DEFAULT_STALE_RUNNER_THRESHOLD_MINUTES;
  const staleRunners = detectStaleRunners(runners, staleRunnerThreshold);

  const byStatus: Record<string, number> = {};
  for (const task of activeTasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  }

  const totalStuck = stuckTasks.length;
  const totalSuspicious = suspiciousTasks.length;
  const totalMissingHumanReports = missingHumanReports.length;
  const totalStaleRunners = staleRunners.length;
  const healthy = totalStuck === 0 && totalSuspicious === 0 && totalMissingHumanReports === 0 && totalStaleRunners === 0;

  return {
    stuckTasks,
    suspiciousTasks,
    missingHumanReports,
    staleRunners,
    summary: {
      totalActive: activeTasks.length,
      byStatus,
      totalStuck,
      totalSuspicious,
      totalMissingHumanReports,
      totalStaleRunners,
      healthy,
    },
  };
}

export function formatAuditReport(result: AuditResult): string {
  const lines: string[] = [];

  // Summary line
  if (result.summary.healthy) {
    lines.push("audit: healthy");
  } else {
    const issues: string[] = [];
    if (result.summary.totalStuck > 0) issues.push(`${result.summary.totalStuck} stuck`);
    if (result.summary.totalSuspicious > 0) issues.push(`${result.summary.totalSuspicious} suspicious`);
    if (result.summary.totalMissingHumanReports > 0) issues.push(`${result.summary.totalMissingHumanReports} missing human reports`);
    if (result.summary.totalStaleRunners > 0) issues.push(`${result.summary.totalStaleRunners} stale runners`);
    lines.push(`audit: ${issues.join(", ")}`);
  }

  // Active tasks breakdown
  if (result.summary.totalActive > 0) {
    const statusParts = Object.entries(result.summary.byStatus)
      .map(([status, count]) => `${count} ${status}`)
      .join(", ");
    lines.push(`active: ${result.summary.totalActive} (${statusParts})`);
  }

  // Stuck tasks
  for (const st of result.stuckTasks) {
    const shortId = st.taskId.slice(0, SHORT_ID_LENGTH);
    lines.push(`stuck: [${shortId}] ${st.title} (${st.status}, ${st.stuckMinutes}m)`);
  }

  // Suspicious tasks
  for (const st of result.suspiciousTasks) {
    const shortId = st.taskId.slice(0, SHORT_ID_LENGTH);
    lines.push(`suspicious: [${shortId}] ${st.title} (${st.reasons.join(", ")})`);
  }

  // Missing human reports
  for (const ct of result.missingHumanReports) {
    const shortId = ct.taskId.slice(0, SHORT_ID_LENGTH);
    lines.push(`missing_report: [${shortId}] ${ct.title}`);
  }

  // Stale runners
  for (const sr of result.staleRunners) {
    lines.push(`stale_runner: ${sr.missionName} (${sr.staleSinceMinutes}m since heartbeat)`);
  }

  return lines.join("\n");
}

export async function audit(queue: TaskQueue, _args: string[]): Promise<void> {
  const result = await runAudit(queue);
  console.log(formatAuditReport(result));
}
