import type { TaskQueue } from "../queue";
import type { Task } from "../task";
import { createTask, SHORT_ID_LENGTH, HUMAN_REQUIRED_PREFIX, getHumanQuestion } from "../task";
import type { FeedbackSummary } from "../feedback";
import { loadFeedback, summarizeFeedback, distillFeedback, extractObservationalContent, verifyDistilledRules, markRuleTaskCreated, acknowledgeFeedback, type CodeChangeChecker } from "../feedback";
import type { Mission } from "../mission";
import { loadMissions, reactivateMission, archiveMissions } from "../mission";
import type { SourceResult } from "../sources";
import { runAllSources } from "../sources";
import { loadPrinciples } from "../principles";
import type { Report } from "../reports";
import { loadReports, isVacuousContent } from "../reports";
import { runOnDoneHooks } from "../hooks";
import type { ServerLogSummary } from "../server-log";
import { loadRecentServerLogs, summarizeServerLogs } from "../server-log";
import { loadConfig } from "../config";
import { dirname } from "path";

export interface IterateContext {
  feedbackPath?: string;
  missionsPath?: string;
  reportsPath?: string;
  sourcesPath?: string;
  principlesPath?: string;
  serverLogPath?: string;
  templatePath?: string;
  distilledRulesPath?: string;
  missionArchivePath?: string;
  codeChangeChecker?: CodeChangeChecker;
}

export interface CompletedFeedbackTask {
  taskId: string;
  title: string;
  feedbackIds: string[];
}

export interface SuspiciousTask {
  taskId: string;
  title: string;
  reasons: string[];
}

export interface StuckTask {
  taskId: string;
  title: string;
  status: string;
  stuckMinutes: number;
}

export interface Observation {
  feedbackSummary: FeedbackSummary;
  activeMissions: Mission[];
  failedMissions: Mission[];
  sourceResults: SourceResult[];
  principles: string;
  tasks: Task[];
  waitingHumanTasks: Task[];
  answeredHumanTasks: Task[];
  suspiciousTasks: SuspiciousTask[];
  stuckTasks: StuckTask[];
  failedTasks: Task[];
  completedFeedbackTasks: CompletedFeedbackTask[];
  uncommittedChanges: string;
  serverLogSummary: ServerLogSummary | null;
}

export interface RecoverResult {
  recoveredTasks: string[];
  permanentlyFailed: string[];
}

export interface RequeueResult {
  requeuedTasks: string[];
  permanentlyFailed: string[];
}

export interface GenerateResult {
  createdTasks: string[];
  retriedTasks: string[];
  resumedTasks: string[];
  recoveredTasks: string[];
  requeuedSuspiciousTasks: string[];
  distilledRules: string[];
  autonomousTasks: string[];
  unverifiedRules: string[];
  humanReportTasks: string[];
  feedbackIdsToAck: string[];
}

const IN_PROGRESS_STATUSES = new Set(["orienting", "deciding", "acting"]);
const DEFAULT_STUCK_THRESHOLD_MINUTES = 30;

export function detectStuckTasks(tasks: Task[], thresholdMinutes: number = DEFAULT_STUCK_THRESHOLD_MINUTES): StuckTask[] {
  const now = Date.now();
  const thresholdMs = thresholdMinutes * 60 * 1000;
  const stuck: StuckTask[] = [];
  for (const task of tasks) {
    if (!IN_PROGRESS_STATUSES.has(task.status)) continue;
    const elapsed = now - new Date(task.updatedAt).getTime();
    if (elapsed > thresholdMs) {
      stuck.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        stuckMinutes: Math.floor(elapsed / 60000),
      });
    }
  }
  return stuck;
}

const MAX_STUCK_RETRIES = 2;

export function recoverStuckTasks(queue: TaskQueue, stuckTasks: StuckTask[]): RecoverResult {
  const recoveredTasks: string[] = [];
  const permanentlyFailed: string[] = [];

  for (const stuck of stuckTasks) {
    const task = queue.get(stuck.taskId);
    if (!task) continue;

    const actLogCount = task.logs.filter(l => l.phase === "act").length;
    queue.addLog(task.id, "act", `[STUCK] recovered after ${stuck.stuckMinutes}m in ${stuck.status}`);
    queue.transition(task.id, "failed");
    queue.update(task.id, { owner: undefined });

    if (actLogCount < MAX_STUCK_RETRIES) {
      queue.transition(task.id, "observing");
      recoveredTasks.push(task.id);
    } else {
      permanentlyFailed.push(task.id);
    }
  }

  return { recoveredTasks, permanentlyFailed };
}

const MAX_SUSPICIOUS_RETRIES = 2;
const ITERATE_CREATOR = "iterate";
const WORQLOAD_CREATOR = "worqload";

// Requeue suspicious done tasks directly in iterate (main session),
// avoiding the "who monitors the monitors?" problem by keeping audit
// as a systemic guarantee rather than a delegated task.
export function requeueSuspiciousTasks(queue: TaskQueue, suspiciousTasks: SuspiciousTask[]): RequeueResult {
  const requeuedTasks: string[] = [];
  const permanentlyFailed: string[] = [];

  for (const suspicious of suspiciousTasks) {
    const task = queue.get(suspicious.taskId);
    if (!task) continue;

    // Skip system-generated iterate/worqload tasks — they are internal bookkeeping
    if (task.createdBy === ITERATE_CREATOR || task.createdBy === WORQLOAD_CREATOR) continue;

    const actLogCount = task.logs.filter(l => l.phase === "act").length;
    queue.addLog(task.id, "act", `[SUSPICIOUS] requeued: ${suspicious.reasons.join(", ")}`);
    queue.transition(task.id, "failed");
    queue.update(task.id, { owner: undefined });

    if (actLogCount < MAX_SUSPICIOUS_RETRIES) {
      queue.transition(task.id, "observing");
      requeuedTasks.push(task.id);
    } else {
      permanentlyFailed.push(task.id);
    }
  }

  return { requeuedTasks, permanentlyFailed };
}

const MIN_ACT_CONTENT_LENGTH = 10;
const MIN_REPORT_CONTENT_LENGTH = 50;
const DEFAULT_AUDIT_WINDOW_MINUTES = 10;

export async function auditRecentCompletions(
  queue: TaskQueue,
  ctx: IterateContext,
  windowMinutes: number = DEFAULT_AUDIT_WINDOW_MINUTES,
): Promise<SuspiciousTask[]> {
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;
  const recentDone = queue.list().filter(t => {
    if (t.status !== "done") return false;
    return now - new Date(t.updatedAt).getTime() <= windowMs;
  });

  const reports = ctx.reportsPath
    ? await loadReports(ctx.reportsPath).catch(() => [] as { id: string; title: string; content: string }[])
    : [];

  const suspicious: SuspiciousTask[] = [];
  for (const task of recentDone) {
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

    if (ctx.reportsPath) {
      const shortId = task.id.slice(0, SHORT_ID_LENGTH);
      const matchingReport = reports.find(
        r => r.content.includes(task.id) || r.content.includes(shortId)
          || r.title.includes(task.id) || r.title.includes(shortId),
      );
      if (!matchingReport) {
        reasons.push("no report found");
      } else if (matchingReport.content.length < MIN_REPORT_CONTENT_LENGTH || isVacuousContent(matchingReport.content)) {
        reasons.push("report lacks substance");
      }
    }

    if (reasons.length > 0) {
      suspicious.push({ taskId: task.id, title: task.title, reasons });
    }
  }
  return suspicious;
}

function extractFeedbackIds(context: Record<string, unknown>): string[] | null {
  if (Array.isArray(context.feedbackIds) && context.feedbackIds.length > 0) {
    return context.feedbackIds as string[];
  }
  if (typeof context.feedbackId === "string") {
    return [context.feedbackId];
  }
  return null;
}

export function needsHumanReport(task: Task): boolean {
  if (task.title.startsWith(REPORT_HUMAN_PREFIX)) return false;
  if (extractFeedbackIds(task.context)) return true;
  if (task.logs.some(l => l.content.startsWith(HUMAN_REQUIRED_PREFIX))) return true;
  return false;
}

export async function detectCompletedFeedbackTasks(
  queue: TaskQueue,
  ctx: IterateContext,
  excludeTaskId?: string,
): Promise<CompletedFeedbackTask[]> {
  const queueDone = queue.list().filter(t =>
    t.status === "done" && t.id !== excludeTaskId,
  );
  const archivedDone = (await queue.history()).filter(t =>
    t.status === "done" && t.id !== excludeTaskId,
  );
  const doneTasks = [...queueDone, ...archivedDone];

  const reports = ctx.reportsPath
    ? await loadReports(ctx.reportsPath).catch(() => [] as Report[])
    : [];

  const result: CompletedFeedbackTask[] = [];
  for (const task of doneTasks) {
    if (!needsHumanReport(task)) continue;

    const hasHumanReport = reports.some(
      r => r.taskId === task.id && r.category === "human",
    );
    if (hasHumanReport) continue;

    const feedbackIds = extractFeedbackIds(task.context) ?? [];
    result.push({ taskId: task.id, title: task.title, feedbackIds });
  }
  return result;
}

export async function getUncommittedChanges(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim();
  } catch {
    return "";
  }
}

const DEFAULT_MANAGED_DIR = ".worqload";

export function filterManagedPaths(gitStatus: string, storePath?: string): string {
  if (!gitStatus) return "";
  const managedDir = storePath ? dirname(storePath) : DEFAULT_MANAGED_DIR;
  const prefix = managedDir + "/";
  return gitStatus
    .split("\n")
    .filter(line => {
      const path = line.slice(3);
      return !path.startsWith(prefix);
    })
    .join("\n");
}

export function hasHumanAnswer(task: Task): boolean {
  let lastHumanRequiredIndex = -1;
  for (let i = task.logs.length - 1; i >= 0; i--) {
    if (task.logs[i].content.startsWith(HUMAN_REQUIRED_PREFIX)) {
      lastHumanRequiredIndex = i;
      break;
    }
  }
  if (lastHumanRequiredIndex === -1) return false;
  return task.logs.slice(lastHumanRequiredIndex + 1).some(
    l => l.phase === "orient" && !l.content.startsWith(HUMAN_REQUIRED_PREFIX),
  );
}

export async function collectObservation(queue: TaskQueue, ctx: IterateContext, excludeTaskId?: string): Promise<Observation> {
  const allTasks = queue.list().filter(t => t.id !== excludeTaskId);
  const allWaitingHuman = allTasks.filter(t => t.status === "waiting_human");
  const answeredHumanTasks = allWaitingHuman.filter(hasHumanAnswer);
  const waitingHumanTasks = allWaitingHuman.filter(t => !hasHumanAnswer(t));
  const activeTasks = allTasks.filter(t => t.status !== "done" && t.status !== "failed" && t.status !== "waiting_human");
  const failedTasks = allTasks.filter(t => t.status === "failed");

  const SERVER_LOG_OBSERVE_WINDOW_MS = 10 * 60 * 1000;

  const [feedbackItems, missions, sourceResults, principles, suspiciousTasks, completedFeedbackTasks, rawUncommittedChanges, serverLogs] = await Promise.all([
    loadFeedback(ctx.feedbackPath),
    loadMissions(ctx.missionsPath),
    runAllSources(ctx.sourcesPath).catch(() => [] as SourceResult[]),
    loadPrinciples(ctx.principlesPath),
    auditRecentCompletions(queue, ctx),
    detectCompletedFeedbackTasks(queue, ctx, excludeTaskId),
    getUncommittedChanges(),
    loadRecentServerLogs(SERVER_LOG_OBSERVE_WINDOW_MS, ctx.serverLogPath).catch(() => [] as import("../server-log").ServerLogEntry[]),
  ]);
  const uncommittedChanges = filterManagedPaths(rawUncommittedChanges, queue.getStorePath());

  const serverLogSummary = serverLogs.length > 0 ? summarizeServerLogs(serverLogs) : null;
  const stuckTasks = detectStuckTasks(activeTasks);

  return {
    feedbackSummary: summarizeFeedback(feedbackItems),
    activeMissions: missions.filter(m => m.status === "active"),
    failedMissions: missions.filter(m => m.status === "failed"),
    sourceResults,
    principles,
    tasks: activeTasks,
    waitingHumanTasks,
    answeredHumanTasks,
    suspiciousTasks,
    stuckTasks,
    failedTasks,
    completedFeedbackTasks,
    uncommittedChanges,
    serverLogSummary,
  };
}

export function analyzeObservation(obs: Observation): string {
  const tags: string[] = [];
  const lines: string[] = [];

  if (obs.answeredHumanTasks.length > 0) {
    tags.push("answered_human");
    for (const t of obs.answeredHumanTasks) {
      lines.push(`answered_human: [${t.id.slice(0, SHORT_ID_LENGTH)}] ${t.title}`);
    }
  }

  if (obs.waitingHumanTasks.length > 0) {
    tags.push("waiting_human");
    for (const t of obs.waitingHumanTasks) {
      lines.push(`waiting_human: [${t.id.slice(0, SHORT_ID_LENGTH)}] ${t.title}`);
    }
  }

  const observingTasks = obs.tasks.filter(t => t.status === "observing");
  if (observingTasks.length > 0) {
    tags.push("has_pending");

    const byMission = new Map<string, { name: string; count: number }>();
    let unassignedCount = 0;
    for (const t of observingTasks) {
      if (t.missionId) {
        const entry = byMission.get(t.missionId);
        if (entry) {
          entry.count++;
        } else {
          const mission = obs.activeMissions.find(m => m.id === t.missionId);
          byMission.set(t.missionId, { name: mission?.name ?? t.missionId.slice(0, SHORT_ID_LENGTH), count: 1 });
        }
      } else {
        unassignedCount++;
      }
    }

    for (const [id, { name, count }] of byMission) {
      lines.push(`mission_run: ${id.slice(0, SHORT_ID_LENGTH)} "${name}" (${count} task${count > 1 ? "s" : ""})`);
    }
    if (unassignedCount > 0) {
      lines.push(`unassigned: ${unassignedCount} task${unassignedCount > 1 ? "s" : ""}`);
    }
  }

  const executingTasks = obs.tasks.filter(t => t.status === "orienting" || t.status === "acting");
  if (executingTasks.length > 0) {
    tags.push("has_executing");
    const now = Date.now();
    for (const t of executingTasks) {
      const elapsedMinutes = Math.floor((now - new Date(t.updatedAt).getTime()) / 60000);
      lines.push(`${t.status}: [${t.id.slice(0, SHORT_ID_LENGTH)}] ${t.title} (${elapsedMinutes}m)`);
    }
  }

  const decidingTasks = obs.tasks.filter(t => t.status === "deciding");
  if (decidingTasks.length > 0) {
    tags.push("has_deciding");
    for (const t of decidingTasks) {
      lines.push(`deciding: [${t.id.slice(0, SHORT_ID_LENGTH)}] ${t.title}`);
    }
  }

  if (obs.tasks.length === 0 && obs.waitingHumanTasks.length === 0 && obs.answeredHumanTasks.length === 0) {
    tags.push("queue_empty");
    lines.push("queue is empty");
  }

  if (obs.feedbackSummary.counts.new > 0) {
    lines.push(`new feedback: ${obs.feedbackSummary.counts.new}`);
  }
  for (const theme of obs.feedbackSummary.themes) {
    lines.push(`feedback theme: ${theme.description}`);
  }

  if (obs.activeMissions.length > 0) {
    lines.push(`active missions: ${obs.activeMissions.map(m => m.name).join(", ")}`);
  }

  if (obs.failedMissions.length > 0) {
    lines.push(`failed missions: ${obs.failedMissions.map(m => m.name).join(", ")}`);
  }

  if (obs.principles) {
    const principleItems = obs.principles.split("\n").filter(l => l.startsWith("- "));
    for (const item of principleItems) {
      lines.push(`principle: ${item.slice(2)}`);
    }
  }

  for (const sr of obs.sourceResults) {
    if (sr.output) {
      lines.push(`source[${sr.name}]: ${sr.output.slice(0, 200)}`);
    }
  }

  for (const st of obs.suspiciousTasks) {
    const shortId = st.taskId.slice(0, SHORT_ID_LENGTH);
    lines.push(`suspicious: [${shortId}] ${st.title} (${st.reasons.join(", ")})`);
  }

  for (const st of obs.stuckTasks) {
    const shortId = st.taskId.slice(0, SHORT_ID_LENGTH);
    lines.push(`stuck: [${shortId}] ${st.title} (${st.status}, ${st.stuckMinutes}m)`);
  }

  if (obs.failedTasks.length > 0) {
    lines.push(`failed: ${obs.failedTasks.length} task${obs.failedTasks.length > 1 ? "s" : ""}`);
  }

  if (obs.completedFeedbackTasks?.length > 0) {
    tags.push("report_human");
    for (const ct of obs.completedFeedbackTasks) {
      lines.push(`report_human: [${ct.taskId.slice(0, SHORT_ID_LENGTH)}] ${ct.title}`);
    }
  }

  if (obs.uncommittedChanges) {
    lines.push("uncommitted changes detected");
  }

  if (obs.serverLogSummary) {
    const s = obs.serverLogSummary;
    lines.push(`server: ${s.totalRequests} reqs, ${s.errorCount} errors (${Math.round(s.errorRate * 100)}%), avg ${s.avgDurationMs}ms`);
    if (s.errorPaths.length > 0) {
      lines.push(`server errors on: ${s.errorPaths.join(", ")}`);
    }
  }

  return `[${tags.join(",")}] ${lines.join("; ")}`;
}

const MAX_RETRY_ATTEMPTS = 2;
const COMMIT_TASK_TITLE = "Commit uncommitted changes";
const REVIEW_FEEDBACK_PREFIX = "Review feedback:";
const INVESTIGATE_FEEDBACK_PREFIX = "Investigate feedback:";
const IMPLEMENT_RULE_PREFIX = "Implement distilled rule:";
const REPORT_HUMAN_PREFIX = "Report to human:";

export const TASK_PRIORITY = {
  FEEDBACK_INVESTIGATE: 30,
  FEEDBACK_REVIEW: 20,
  HUMAN_REPORT: 15,
  COMMIT: 10,
  IMPLEMENT_RULE: 10,
  AUTONOMOUS: 0,
} as const;

interface DuplicateCheckOptions {
  prefixMatch?: boolean;
  includeDone?: boolean;
}

function hasDuplicateTask(queue: TaskQueue, existingTasks: Task[], title: string, archivedTasks: Task[] = [], options: DuplicateCheckOptions = {}): boolean {
  const isMatch = options.prefixMatch
    ? (t: Task) => t.title.startsWith(title)
    : (t: Task) => t.title === title;

  // Archived tasks are always considered duplicates regardless of status
  if (archivedTasks.some(isMatch)) return true;

  const activeTasks = [...queue.list(), ...existingTasks];
  const excludedStatuses: string[] = ["failed"];
  if (!options.includeDone) {
    excludedStatuses.push("done");
  }
  return activeTasks.some(t => isMatch(t) && !excludedStatuses.includes(t.status));
}

const AUTONOMOUS_FEEDBACK_REVIEW_TITLE = "Review unresolved feedback";
const AUTONOMOUS_TEST_FIX_TITLE = "Fix failing tests";
const AUTONOMOUS_INVESTIGATION_TITLE = "Investigate improvements based on Principles";

function parsePrincipleItems(principles: string): string[] {
  return principles.split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2).trim());
}

function hasTestFailures(sourceResults: SourceResult[]): boolean {
  return sourceResults.some(sr =>
    sr.name.toLowerCase().includes("test") && sr.exitCode !== 0 && /\bfail\b/i.test(sr.output),
  );
}

export interface DerivedTask {
  title: string;
  context: Record<string, unknown>;
}

export function deriveAutonomousTasks(obs: Observation, queue: TaskQueue, archivedTasks: Task[]): DerivedTask[] {
  const derived: DerivedTask[] = [];

  // Unresolved feedback → one review task per feedback
  const unresolvedFeedbackIds = obs.feedbackSummary.unresolvedIds ?? [];
  for (const feedbackId of unresolvedFeedbackIds) {
    const title = `${AUTONOMOUS_FEEDBACK_REVIEW_TITLE} [${feedbackId}]`;
    if (!hasDuplicateTask(queue, obs.tasks, title, archivedTasks)) {
      derived.push({ title, context: { feedbackId } });
    }
  }

  // Test failures → test fix task
  if (hasTestFailures(obs.sourceResults)) {
    if (!hasDuplicateTask(queue, obs.tasks, AUTONOMOUS_TEST_FIX_TITLE, archivedTasks)) {
      derived.push({ title: AUTONOMOUS_TEST_FIX_TITLE, context: {} });
    }
  }

  // If no actionable tasks derived yet and principles exist, derive a general investigation task.
  // Archive duplicates are intentionally ignored — investigation is a recurring activity
  // that should restart each time the queue empties.
  const principleItems = parsePrincipleItems(obs.principles);
  if (derived.length === 0 && principleItems.length > 0) {
    if (!hasDuplicateTask(queue, obs.tasks, AUTONOMOUS_INVESTIGATION_TITLE, [])) {
      derived.push({ title: AUTONOMOUS_INVESTIGATION_TITLE, context: { principles: principleItems } });
    }
  }

  return derived;
}

export async function generateTasksFromObservation(queue: TaskQueue, obs: Observation, ctx: IterateContext = {}): Promise<GenerateResult> {
  const createdTasks: string[] = [];
  const retriedTasks: string[] = [];
  const resumedTasks: string[] = [];
  const archivedTasks = await queue.history();

  // Recover stuck tasks before other processing
  const stuckRecovery = recoverStuckTasks(queue, obs.stuckTasks);

  // Requeue suspicious done tasks (no act logs, vacuous content, etc.)
  const suspiciousRequeue = requeueSuspiciousTasks(queue, obs.suspiciousTasks);

  // Uncommitted changes → commit task
  if (obs.uncommittedChanges.length > 0) {
    if (!hasDuplicateTask(queue, obs.tasks, COMMIT_TASK_TITLE, archivedTasks)) {
      const task = createTask(COMMIT_TASK_TITLE, { gitStatus: obs.uncommittedChanges }, TASK_PRIORITY.COMMIT, "iterate");
      queue.enqueue(task);
      createdTasks.push(task.title);
    }
  }

  // Feedback IDs to auto-acknowledge when tasks are created
  const feedbackIdsToAck = new Set<string>();

  // New feedback themes → review tasks
  for (const theme of obs.feedbackSummary.themes) {
    const title = `Review feedback: ${theme.description}`;
    if (!hasDuplicateTask(queue, obs.tasks, REVIEW_FEEDBACK_PREFIX, archivedTasks, { prefixMatch: true, includeDone: true })) {
      const task = createTask(title, { feedbackIds: theme.feedbackIds }, TASK_PRIORITY.FEEDBACK_REVIEW, "iterate");
      queue.enqueue(task);
      createdTasks.push(task.title);
      for (const fid of theme.feedbackIds) feedbackIdsToAck.add(fid);
    }
  }

  // Observational (non-directive) feedback → investigation tasks
  for (const feedback of obs.feedbackSummary.recentUnresolved) {
    const observations = extractObservationalContent(feedback.message);
    if (observations.length > 0) {
      const title = `${INVESTIGATE_FEEDBACK_PREFIX} ${observations[0]}`;
      if (!hasDuplicateTask(queue, obs.tasks, title, archivedTasks)) {
        const task = createTask(title, { feedbackIds: [feedback.id], observations }, TASK_PRIORITY.FEEDBACK_INVESTIGATE, "iterate");
        queue.enqueue(task);
        createdTasks.push(task.title);
        feedbackIdsToAck.add(feedback.id);
      }
    }
  }

  // Failed tasks → retry by transitioning back to observing
  const reactivatedMissions = new Set<string>();
  for (const failedTask of obs.failedTasks) {
    const actLogCount = failedTask.logs.filter(l => l.phase === "act").length;
    if (actLogCount < MAX_RETRY_ATTEMPTS) {
      queue.transition(failedTask.id, "observing");
      retriedTasks.push(failedTask.id);
      if (failedTask.missionId) {
        reactivatedMissions.add(failedTask.missionId);
      }
    }
  }

  // Reactivate failed missions whose tasks were retried
  for (const missionId of reactivatedMissions) {
    const mission = obs.failedMissions.find(m => m.id === missionId);
    if (mission) {
      await reactivateMission(missionId, ctx.missionsPath);
    }
  }

  // Answered waiting_human tasks → resume to orienting (answer is Orient output)
  for (const answeredTask of obs.answeredHumanTasks) {
    queue.transition(answeredTask.id, "orienting");
    resumedTasks.push(answeredTask.id);
  }

  // Distill resolved feedback into agent template rules
  let distilledRules: string[] = [];
  const justDistilledRuleIds = new Set<string>();
  if (obs.feedbackSummary.counts.resolved > 0 && ctx.templatePath) {
    const distillResult = await distillFeedback(ctx.feedbackPath, ctx.templatePath, ctx.distilledRulesPath);
    distilledRules = distillResult.rules;
    for (const rule of distillResult.pendingVerification) {
      justDistilledRuleIds.add(rule.id);
    }
  }

  // Verify distilled rules and create tasks for unverified ones
  // Rules distilled in this iteration are skipped — they need time to be implemented
  const unverifiedRules: string[] = [];
  if (ctx.distilledRulesPath) {
    const verifyResult = await verifyDistilledRules(ctx.distilledRulesPath, ctx.codeChangeChecker);
    for (const rule of verifyResult.unverified) {
      if (justDistilledRuleIds.has(rule.id)) continue;
      const title = `${IMPLEMENT_RULE_PREFIX} ${rule.rule}`;
      if (!hasDuplicateTask(queue, obs.tasks, title, archivedTasks)) {
        const task = createTask(title, { distilledRuleId: rule.id, rule: rule.rule }, TASK_PRIORITY.IMPLEMENT_RULE, "iterate");
        queue.enqueue(task);
        createdTasks.push(task.title);
        unverifiedRules.push(rule.rule);
      }
      await markRuleTaskCreated(rule.id, ctx.distilledRulesPath);
    }
  }

  // Completed feedback tasks → human report tasks
  const humanReportTasks: string[] = [];
  for (const completed of obs.completedFeedbackTasks ?? []) {
    const title = `${REPORT_HUMAN_PREFIX} ${completed.title}`;
    if (!hasDuplicateTask(queue, obs.tasks, title, archivedTasks)) {
      const task = createTask(title, {
        sourceTaskId: completed.taskId,
        sourceTaskTitle: completed.title,
        feedbackIds: completed.feedbackIds,
      }, TASK_PRIORITY.HUMAN_REPORT, "iterate");
      queue.enqueue(task);
      humanReportTasks.push(task.title);
    }
  }

  // Autonomous task derivation from principles when queue is empty
  const autonomousTasks: string[] = [];
  const isQueueEmpty = obs.tasks.length === 0
    && obs.waitingHumanTasks.length === 0
    && obs.answeredHumanTasks.length === 0;
  const nothingGeneratedYet = createdTasks.length === 0
    && retriedTasks.length === 0
    && resumedTasks.length === 0
    && stuckRecovery.recoveredTasks.length === 0;

  if (isQueueEmpty && nothingGeneratedYet && obs.principles) {
    const derived = deriveAutonomousTasks(obs, queue, archivedTasks);
    for (const { title, context } of derived) {
      const task = createTask(title, context, TASK_PRIORITY.AUTONOMOUS, "iterate");
      queue.enqueue(task);
      autonomousTasks.push(task.title);
      const fids = extractFeedbackIds(context);
      if (fids) for (const fid of fids) feedbackIdsToAck.add(fid);
    }
  }

  return { createdTasks, retriedTasks, resumedTasks, recoveredTasks: stuckRecovery.recoveredTasks, requeuedSuspiciousTasks: suspiciousRequeue.requeuedTasks, distilledRules, autonomousTasks, unverifiedRules, humanReportTasks, feedbackIdsToAck: Array.from(feedbackIdsToAck) };
}

export async function ackFeedbackIds(ids: string[], feedbackPath: string): Promise<void> {
  for (const fid of ids) {
    try {
      await acknowledgeFeedback(fid, feedbackPath);
    } catch {
      // Feedback may have already been resolved or removed
    }
  }
}

export interface CleanupResult {
  archivedCount: number;
  archivedMissionCount: number;
  unreadReports: string[];
}

export async function performActCleanup(queue: TaskQueue, ctx: IterateContext): Promise<CleanupResult> {
  const archivableIds = queue.list()
    .filter(t => t.status === "done" || t.status === "failed")
    .map(t => t.id);
  const archived = await queue.archive(archivableIds);

  let archivedMissionCount = 0;
  if (ctx.missionsPath) {
    const missions = await loadMissions(ctx.missionsPath);
    const nonActiveIds = missions
      .filter(m => m.status !== "active")
      .map(m => m.id);
    if (nonActiveIds.length > 0) {
      const archivedMissions = await archiveMissions(nonActiveIds, ctx.missionsPath, ctx.missionArchivePath);
      archivedMissionCount = archivedMissions.length;
    }
  }

  let unreadReports: string[] = [];
  if (ctx.reportsPath) {
    const reports = await loadReports(ctx.reportsPath).catch(() => [] as Report[]);
    unreadReports = reports
      .filter(r => r.status === "unread")
      .map(r => r.title);
  }

  return { archivedCount: archived.length, archivedMissionCount, unreadReports };
}

export function formatCleanupLog(cleanup: CleanupResult): string {
  const parts: string[] = [];
  if (cleanup.archivedCount > 0) {
    parts.push(`archived ${cleanup.archivedCount} task(s)`);
  }
  if (cleanup.archivedMissionCount > 0) {
    parts.push(`archived ${cleanup.archivedMissionCount} mission(s)`);
  }
  if (cleanup.unreadReports.length > 0) {
    parts.push(`${cleanup.unreadReports.length} unread report(s): ${cleanup.unreadReports.join(", ")}`);
  }
  return parts.join("; ");
}

// Queue-wide OODA: surveys all tasks, feedback, missions, and sources to decide
// the orchestration agent's next action (waiting_human / queue_empty / has_pending).
// Contrast with mission-runner.ts iterateMission(), which processes a single task
// within one mission.
export interface IterateOptions {
  ctxOverride?: Partial<IterateContext>;
  observationOverride?: Observation;
}

export async function iterate(queue: TaskQueue, args: string[], options?: IterateOptions): Promise<void> {
  const iterationTask = createTask("Iterate: OODA cycle", {}, 0, "worqload");
  queue.enqueue(iterationTask);
  const id = iterationTask.id;
  const shortId = id.slice(0, SHORT_ID_LENGTH);

  const config = await loadConfig();
  const templatePath = config.init?.agentPath || ".claude/skills/worqload/SKILL.md";
  const ctx: IterateContext = { templatePath, ...options?.ctxOverride };

  // Observe
  const obs = options?.observationOverride ?? await collectObservation(queue, ctx, id);
  const observeLog = formatObserveLog(obs);
  queue.addLog(id, "observe", observeLog);

  // Orient
  const analysis = analyzeObservation(obs);
  queue.transition(id, "orienting");
  queue.addLog(id, "orient", analysis);

  // Decide
  queue.transition(id, "deciding");

  // Autonomous task generation and feedback distillation
  const generated = await generateTasksFromObservation(queue, obs, ctx);
  const hasGenerated = generated.createdTasks.length > 0 || generated.retriedTasks.length > 0 || generated.resumedTasks.length > 0 || generated.recoveredTasks.length > 0 || generated.requeuedSuspiciousTasks.length > 0 || generated.distilledRules.length > 0 || generated.autonomousTasks.length > 0 || generated.unverifiedRules.length > 0;

  if (hasGenerated) {
    const genParts: string[] = [];
    if (generated.createdTasks.length > 0) {
      genParts.push(`created ${generated.createdTasks.length} task(s): ${generated.createdTasks.join(", ")}`);
    }
    if (generated.autonomousTasks.length > 0) {
      genParts.push(`autonomous ${generated.autonomousTasks.length} task(s): ${generated.autonomousTasks.join(", ")}`);
    }
    if (generated.recoveredTasks.length > 0) {
      genParts.push(`recovered ${generated.recoveredTasks.length} stuck task(s)`);
    }
    if (generated.requeuedSuspiciousTasks.length > 0) {
      genParts.push(`requeued ${generated.requeuedSuspiciousTasks.length} suspicious task(s)`);
    }
    if (generated.retriedTasks.length > 0) {
      genParts.push(`retried ${generated.retriedTasks.length} failed task(s)`);
    }
    if (generated.resumedTasks.length > 0) {
      genParts.push(`resumed ${generated.resumedTasks.length} answered task(s)`);
    }
    if (generated.distilledRules.length > 0) {
      genParts.push(`distilled ${generated.distilledRules.length} feedback rule(s) into template`);
    }
    if (generated.unverifiedRules.length > 0) {
      genParts.push(`${generated.unverifiedRules.length} unverified rule(s) → implementation task(s)`);
    }
    const genSummary = genParts.join("; ");
    const decideTag = generated.autonomousTasks.length > 0 ? "autonomous_tasks" : "tasks_created";
    queue.addLog(id, "decide", `${decideTag}: ${genSummary}`);
    queue.transition(id, "acting");
    const cleanup1 = await performActCleanup(queue, ctx);
    const cleanupLog1 = formatCleanupLog(cleanup1);
    const actSummary1 = [genSummary, cleanupLog1].filter(Boolean).join("; ");
    queue.addLog(id, "act", actSummary1);
    queue.transition(id, "done");
    await queue.save();
    await runOnDoneHooks(id, iterationTask.title);
    console.log(`[${shortId}] Iteration complete: ${decideTag} — ${actSummary1}`);
    if (obs.feedbackSummary.counts.new > 0) {
      console.log(`  new feedback: ${obs.feedbackSummary.counts.new}`);
    }
    return;
  }

  if (obs.waitingHumanTasks.length > 0) {
    const questions = obs.waitingHumanTasks.map(t => {
      const question = getHumanQuestion(t) ?? t.title;
      return `[${t.id.slice(0, SHORT_ID_LENGTH)}] ${question}`;
    });
    queue.addLog(id, "decide", `present waiting_human: ${questions.join("; ")}`);
    queue.transition(id, "acting");
    const cleanup2 = await performActCleanup(queue, ctx);
    const cleanupLog2 = formatCleanupLog(cleanup2);
    const actSummary2 = [`${obs.waitingHumanTasks.length} waiting_human task(s) on dashboard`, cleanupLog2].filter(Boolean).join("; ");
    queue.addLog(id, "act", actSummary2);
    queue.transition(id, "done");
    await queue.save();
    await runOnDoneHooks(id, iterationTask.title);
    console.log(`[${shortId}] Iteration complete: ${obs.waitingHumanTasks.length} waiting_human task(s) on dashboard`);
    if (obs.feedbackSummary.counts.new > 0) {
      console.log(`  new feedback: ${obs.feedbackSummary.counts.new}`);
    }
    return;
  }

  if (obs.tasks.length === 0) {
    queue.addLog(id, "decide", "queue_empty: no principles defined, add principles to continue");
    queue.transition(id, "acting");
    const cleanup3 = await performActCleanup(queue, ctx);
    const cleanupLog3 = formatCleanupLog(cleanup3);
    const actSummary3 = ["signaled empty queue — no principles defined", cleanupLog3].filter(Boolean).join("; ");
    queue.addLog(id, "act", actSummary3);
    queue.transition(id, "done");
    await queue.save();
    await runOnDoneHooks(id, iterationTask.title);
    const queueEmptyMsg = cleanupLog3
      ? `queue empty — no principles defined, add principles to continue; ${cleanupLog3}`
      : "queue empty — no principles defined, add principles to continue";
    console.log(`[${shortId}] Iteration complete: ${queueEmptyMsg}`);
    if (obs.feedbackSummary.counts.new > 0) {
      console.log(`  new feedback: ${obs.feedbackSummary.counts.new}`);
    }
    return;
  }

  // Has pending tasks — signal to run missions
  const pending = obs.tasks.filter(t => t.status === "observing" && !t.owner);
  const inProgress = obs.tasks.filter(t => t.status !== "observing" || t.owner);

  const missionTasks = new Map<string, { name: string; tasks: Task[] }>();
  const unassigned: Task[] = [];
  for (const t of pending) {
    if (t.missionId) {
      const entry = missionTasks.get(t.missionId);
      if (entry) {
        entry.tasks.push(t);
      } else {
        const mission = obs.activeMissions.find(m => m.id === t.missionId);
        missionTasks.set(t.missionId, { name: mission?.name ?? t.missionId.slice(0, SHORT_ID_LENGTH), tasks: [t] });
      }
    } else {
      unassigned.push(t);
    }
  }

  const decisionParts: string[] = [];
  if (missionTasks.size > 0) {
    decisionParts.push(`run ${missionTasks.size} mission(s)`);
  }
  if (unassigned.length > 0) {
    decisionParts.push(`${unassigned.length} unassigned task(s)`);
  }
  if (inProgress.length > 0) {
    decisionParts.push(`${inProgress.length} task(s) in progress`);
  }
  const decision = decisionParts.join("; ") || "no action needed";
  queue.addLog(id, "decide", decision);

  queue.transition(id, "acting");
  const cleanup4 = await performActCleanup(queue, ctx);
  const cleanupLog4 = formatCleanupLog(cleanup4);
  const actSummary4 = [decision, cleanupLog4].filter(Boolean).join("; ");
  queue.addLog(id, "act", actSummary4);
  queue.transition(id, "done");
  await queue.save();
  await runOnDoneHooks(id, iterationTask.title);

  console.log(`[${shortId}] Iteration complete: ${decision}`);
  for (const [mId, { name, tasks }] of missionTasks) {
    console.log(`  mission_run: [${mId.slice(0, SHORT_ID_LENGTH)}] ${name} (${tasks.length} task${tasks.length > 1 ? "s" : ""})`);
  }
  for (const t of unassigned) {
    console.log(`  unassigned: [${t.id.slice(0, SHORT_ID_LENGTH)}] ${t.title}`);
  }
  if (obs.feedbackSummary.counts.new > 0) {
    console.log(`  new feedback: ${obs.feedbackSummary.counts.new}`);
  }
  if (cleanupLog4) console.log(`  ${cleanupLog4}`);
}

export function formatObserveLog(obs: Observation): string {
  const parts: string[] = [];
  parts.push(`tasks: ${obs.tasks.length} active, ${obs.waitingHumanTasks.length} waiting_human, ${obs.answeredHumanTasks.length} answered`);
  parts.push(`feedback: ${obs.feedbackSummary.counts.new} new, ${obs.feedbackSummary.counts.acknowledged} acked, ${obs.feedbackSummary.counts.resolved} resolved`);
  parts.push(`missions: ${obs.activeMissions.length} active, ${obs.failedMissions.length} failed`);
  parts.push(`sources: ${obs.sourceResults.length} ran`);
  const principleCount = obs.principles ? obs.principles.split("\n").filter(l => l.startsWith("- ")).length : 0;
  parts.push(`principles: ${principleCount}`);
  parts.push(`suspicious: ${obs.suspiciousTasks.length}`);
  parts.push(`stuck: ${obs.stuckTasks.length}`);
  parts.push(`failed: ${obs.failedTasks.length}`);
  if (obs.uncommittedChanges) {
    parts.push("uncommitted: yes");
  }
  if (obs.serverLogSummary) {
    const s = obs.serverLogSummary;
    parts.push(`server: ${s.totalRequests} reqs, ${s.errorCount} errors`);
  }
  return parts.join("; ");
}
