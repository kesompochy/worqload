import type { Task } from "./task";
import { SHORT_ID_LENGTH } from "./task";
import type { TaskQueue } from "./queue";
import type { Mission } from "./mission";
import { loadMissions } from "./mission";
import type { Report } from "./reports";
import { loadReports } from "./reports";
import type { Feedback } from "./feedback";
import { loadFeedback } from "./feedback";

export interface ResumeState {
  activeTasks: Task[];
  waitingHumanTasks: Task[];
  activeMissions: Mission[];
  unreadReports: Report[];
  newFeedback: Feedback[];
}

interface ResumeOptions {
  missionsPath?: string;
  reportsPath?: string;
  feedbackPath?: string;
}

const ACTIVE_STATUSES = new Set(["observing", "orienting", "deciding", "acting"]);

export async function collectResumeState(queue: TaskQueue, options: ResumeOptions = {}): Promise<ResumeState> {
  const tasks = queue.list();

  const [missions, reports, feedback] = await Promise.all([
    loadMissions(options.missionsPath),
    loadReports(options.reportsPath),
    loadFeedback(options.feedbackPath),
  ]);

  return {
    activeTasks: tasks.filter(t => ACTIVE_STATUSES.has(t.status)),
    waitingHumanTasks: tasks.filter(t => t.status === "waiting_human"),
    activeMissions: missions.filter(m => m.status === "active"),
    unreadReports: reports.filter(r => r.status === "unread"),
    newFeedback: feedback.filter(f => f.status === "new"),
  };
}

export function formatResumeSummary(state: ResumeState): string {
  const { activeTasks, waitingHumanTasks, activeMissions, unreadReports, newFeedback } = state;

  const hasAnything = activeTasks.length > 0
    || waitingHumanTasks.length > 0
    || activeMissions.length > 0
    || unreadReports.length > 0
    || newFeedback.length > 0;

  if (!hasAnything) {
    return "Nothing to resume. Queue is empty.";
  }

  const sections: string[] = [];

  if (waitingHumanTasks.length > 0) {
    sections.push(formatTaskSection("Waiting for human", waitingHumanTasks));
  }

  if (newFeedback.length > 0) {
    const lines = newFeedback.map(f => `  - [${f.id.slice(0, SHORT_ID_LENGTH)}] ${f.from}: ${f.message}`);
    sections.push(`New Feedback (${newFeedback.length}):\n${lines.join("\n")}`);
  }

  if (activeTasks.length > 0) {
    sections.push(formatTaskSection("Active tasks", activeTasks));
  }

  if (activeMissions.length > 0) {
    const lines = activeMissions.map(m => `  - [${m.id.slice(0, SHORT_ID_LENGTH)}] ${m.name}`);
    sections.push(`Active Missions (${activeMissions.length}):\n${lines.join("\n")}`);
  }

  if (unreadReports.length > 0) {
    const lines = unreadReports.map(r => `  - [${r.id.slice(0, SHORT_ID_LENGTH)}] ${r.title} (by ${r.createdBy})`);
    sections.push(`Unread Reports (${unreadReports.length}):\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

function formatTaskSection(heading: string, tasks: Task[]): string {
  const lines = tasks.map(t => {
    const priority = t.priority !== 0 ? ` p:${t.priority}` : "";
    return `  - [${t.id.slice(0, SHORT_ID_LENGTH)}] ${t.title} (${t.status})${priority}`;
  });
  return `${heading} (${tasks.length}):\n${lines.join("\n")}`;
}
