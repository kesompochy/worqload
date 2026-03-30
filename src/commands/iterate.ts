import type { TaskQueue } from "../queue";
import type { Task } from "../task";
import { createTask, SHORT_ID_LENGTH, HUMAN_REQUIRED_PREFIX } from "../task";
import type { FeedbackSummary } from "../feedback";
import { loadFeedback, summarizeFeedback } from "../feedback";
import type { Mission } from "../mission";
import { loadMissions } from "../mission";
import type { SourceResult } from "../sources";
import { runAllSources } from "../sources";
import { loadPrinciples } from "../principles";
import { loadReports } from "../reports";
import { runOnDoneHooks } from "../hooks";

export interface IterateContext {
  feedbackPath?: string;
  missionsPath?: string;
  reportsPath?: string;
  sourcesPath?: string;
  principlesPath?: string;
}

export interface Observation {
  feedbackSummary: FeedbackSummary;
  activeMissions: Mission[];
  sourceResults: SourceResult[];
  principles: string;
  tasks: Task[];
  waitingHumanTasks: Task[];
}

export async function collectObservation(queue: TaskQueue, ctx: IterateContext): Promise<Observation> {
  const allTasks = queue.list();
  const waitingHumanTasks = allTasks.filter(t => t.status === "waiting_human");
  const activeTasks = allTasks.filter(t => t.status !== "done" && t.status !== "failed" && t.status !== "waiting_human");

  const [feedbackItems, missions, sourceResults, principles] = await Promise.all([
    loadFeedback(ctx.feedbackPath),
    loadMissions(ctx.missionsPath),
    runAllSources(ctx.sourcesPath).catch(() => [] as SourceResult[]),
    loadPrinciples(ctx.principlesPath),
  ]);

  return {
    feedbackSummary: summarizeFeedback(feedbackItems),
    activeMissions: missions.filter(m => m.status === "active"),
    sourceResults,
    principles,
    tasks: activeTasks,
    waitingHumanTasks,
  };
}

export function analyzeObservation(obs: Observation): string {
  const tags: string[] = [];
  const lines: string[] = [];

  if (obs.waitingHumanTasks.length > 0) {
    tags.push("waiting_human");
    for (const t of obs.waitingHumanTasks) {
      lines.push(`waiting_human: [${t.id.slice(0, SHORT_ID_LENGTH)}] ${t.title}`);
    }
  }

  const observingTasks = obs.tasks.filter(t => t.status === "observing");
  if (observingTasks.length > 0) {
    tags.push("has_pending");
    lines.push(`pending tasks: ${observingTasks.length}`);
  }

  if (obs.tasks.length === 0 && obs.waitingHumanTasks.length === 0) {
    tags.push("queue_empty");
    lines.push("queue is empty");
  }

  if (obs.feedbackSummary.counts.new > 0) {
    lines.push(`new feedback: ${obs.feedbackSummary.counts.new}`);
  }
  for (const theme of obs.feedbackSummary.themes) {
    lines.push(`feedback theme: ${theme}`);
  }

  if (obs.activeMissions.length > 0) {
    lines.push(`active missions: ${obs.activeMissions.map(m => m.name).join(", ")}`);
  }

  if (obs.principles) {
    lines.push(`principles loaded: ${obs.principles.split("\n").filter(l => l.startsWith("- ")).length} items`);
  }

  for (const sr of obs.sourceResults) {
    if (sr.output) {
      lines.push(`source[${sr.name}]: ${sr.output.slice(0, 200)}`);
    }
  }

  return `[${tags.join(",")}] ${lines.join("; ")}`;
}

export async function iterate(queue: TaskQueue, args: string[]): Promise<void> {
  const iterationTask = createTask("Iterate: OODA cycle", {}, 0, "worqload");
  queue.enqueue(iterationTask);
  const id = iterationTask.id;
  const shortId = id.slice(0, SHORT_ID_LENGTH);

  // Observe
  const obs = await collectObservation(queue, {});
  const observeLog = formatObserveLog(obs);
  queue.addLog(id, "observe", observeLog);

  // Orient
  const analysis = analyzeObservation(obs);
  queue.transition(id, "orienting");
  queue.addLog(id, "orient", analysis);

  // Decide
  queue.transition(id, "deciding");

  if (obs.waitingHumanTasks.length > 0) {
    const questions = obs.waitingHumanTasks.map(t => {
      const lastDecideLog = [...t.logs].reverse().find(l => l.phase === "decide");
      const question = lastDecideLog?.content.startsWith(HUMAN_REQUIRED_PREFIX)
        ? lastDecideLog.content.slice(HUMAN_REQUIRED_PREFIX.length)
        : t.title;
      return `[${t.id.slice(0, SHORT_ID_LENGTH)}] ${question}`;
    });
    queue.addLog(id, "decide", `present waiting_human: ${questions.join("; ")}`);
    queue.transition(id, "acting");
    queue.addLog(id, "act", "presented waiting_human questions to user");
    queue.transition(id, "done");
    await queue.save();
    await runOnDoneHooks(id, iterationTask.title);
    console.log(`[${shortId}] Iteration complete: waiting_human tasks presented`);
    for (const q of questions) {
      console.log(`  ${q}`);
    }
    return;
  }

  if (obs.tasks.length === 0) {
    queue.addLog(id, "decide", "queue_empty: propose next action to user");
    queue.transition(id, "acting");
    queue.addLog(id, "act", "signaled empty queue for user proposal");
    queue.transition(id, "done");
    await queue.save();
    await runOnDoneHooks(id, iterationTask.title);
    console.log(`[${shortId}] Iteration complete: queue empty — propose next action`);
    return;
  }

  // Has pending tasks — signal to process them
  const pending = obs.tasks.filter(t => t.status === "observing" && !t.owner);
  const inProgress = obs.tasks.filter(t => t.status !== "observing" || t.owner);
  const decisionParts: string[] = [];
  if (pending.length > 0) {
    decisionParts.push(`spawn ${pending.length} pending task(s)`);
  }
  if (inProgress.length > 0) {
    decisionParts.push(`${inProgress.length} task(s) in progress`);
  }
  const decision = decisionParts.join("; ") || "no action needed";
  queue.addLog(id, "decide", decision);

  queue.transition(id, "acting");
  queue.addLog(id, "act", decision);
  queue.transition(id, "done");
  await queue.save();
  await runOnDoneHooks(id, iterationTask.title);

  console.log(`[${shortId}] Iteration complete: ${decision}`);
  if (pending.length > 0) {
    for (const t of pending) {
      console.log(`  pending: [${t.id.slice(0, SHORT_ID_LENGTH)}] ${t.title}`);
    }
  }
}

function formatObserveLog(obs: Observation): string {
  const parts: string[] = [];
  parts.push(`tasks: ${obs.tasks.length} active, ${obs.waitingHumanTasks.length} waiting_human`);
  parts.push(`feedback: ${obs.feedbackSummary.counts.new} new, ${obs.feedbackSummary.counts.acknowledged} acked`);
  parts.push(`missions: ${obs.activeMissions.length} active`);
  parts.push(`sources: ${obs.sourceResults.length} ran`);
  return parts.join("; ");
}
