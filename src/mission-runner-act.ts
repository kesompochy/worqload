import type { Task } from "./task";
import type { Mission } from "./mission";
import { loadReports, addReport, isVacuousContent, humanFriendlyReportTitle } from "./reports";

export const REPORT_HUMAN_PREFIX = "Report to human:";

export interface EnsureReportOptions {
  reportsPath?: string;
}

export function isPlanTask(task: Task): boolean {
  return task.context.plan === true;
}

export function isReportToHumanTask(task: Task): boolean {
  return task.title.startsWith(REPORT_HUMAN_PREFIX);
}

export function buildActPrompt(task: Task, mission: Mission): string {
  if (isReportToHumanTask(task)) {
    return buildReportToHumanPrompt(task, mission);
  }
  return buildDefaultActPrompt(task, mission);
}

function buildReportToHumanPrompt(task: Task, mission: Mission): string {
  const parts = [`Task: ${task.title}`];
  parts.push(`Mission: ${mission.name}`);

  const feedbackMessages = task.context.feedbackMessages as Array<{ from: string; message: string }> | undefined;
  if (feedbackMessages && feedbackMessages.length > 0) {
    parts.push(`\nFeedback:\n${feedbackMessages.map(f => `${f.from}: ${f.message}`).join("\n")}`);
  }

  if (task.context.sourceTaskId) {
    parts.push(`\nSource task: ${task.context.sourceTaskId}`);
  }

  parts.push(`\nInstructions:
- This is a Report to human task. Your goal is to respond to the human's feedback above.
- Read the source task's logs ($WORQLOAD_CLI show ${task.context.sourceTaskId || "<sourceTaskId>"}) to understand what was done.
- Write the report as a direct answer to the human's original feedback. Address what they asked or reported, and explain the outcome.
- Do NOT list internal implementation steps, file diffs, debugging processes, or code changes. The human wants to know the result, not the process.
- Write in Japanese.
- Use $WORQLOAD_CLI report add $WORQLOAD_TASK_ID "<title>" "<content>" --category human to create the report.
- Do NOT write code, tests, or commits. This task is purely about communication.`);
  return parts.join("\n");
}

function buildDefaultActPrompt(task: Task, mission: Mission): string {
  const parts = [`Task: ${task.title}`];
  if (Object.keys(task.context).length > 0) {
    parts.push(`Context: ${JSON.stringify(task.context)}`);
  }
  parts.push(`Mission: ${mission.name}`);
  if (mission.principles.length > 0) {
    parts.push(`Principles:\n${mission.principles.map(p => `- ${p}`).join("\n")}`);
  }
  parts.push(`\nInstructions:\n- Use $WORQLOAD_CLI to interact with worqload (e.g. $WORQLOAD_CLI report add $WORQLOAD_TASK_ID "title" "content")\n- Write tests first (TDD), then implement\n- Commit your changes when done\n- Keep scope small — one commit-sized unit of work\n- Reports must be in Japanese`);
  return parts.join("\n");
}

export async function ensureReportForDoneTask(
  task: Task,
  missionName: string,
  options: EnsureReportOptions = {},
): Promise<void> {
  if (isReportToHumanTask(task)) return;

  const { reportsPath } = options;

  const reports = await loadReports(reportsPath);
  const existingReport = reports.find(r => r.taskId === task.id);
  if (existingReport) return;

  const actLogs = task.logs
    .filter(l => l.phase === "act")
    .map(l => l.content)
    .filter(c => !c.startsWith("[RETRY]") && !c.startsWith("[FAILED]") && !c.startsWith("[TIMEOUT]"));

  const substantiveLogs = actLogs.filter(c => !isVacuousContent(c));
  if (substantiveLogs.length === 0) return;

  await addReport(humanFriendlyReportTitle(task.title), substantiveLogs.join("\n\n"), `mission:${missionName}`, {
    taskId: task.id,
    path: reportsPath,
  });
}
