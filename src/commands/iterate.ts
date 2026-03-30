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

export async function collectObservation(queue: TaskQueue, ctx: IterateContext, excludeTaskId?: string): Promise<Observation> {
  const allTasks = queue.list().filter(t => t.id !== excludeTaskId);
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

  return `[${tags.join(",")}] ${lines.join("; ")}`;
}

// Queue-wide OODA: surveys all tasks, feedback, missions, and sources to decide
// the orchestration agent's next action (waiting_human / queue_empty / has_pending).
// Contrast with mission-runner.ts iterateMission(), which processes a single task
// within one mission.
export async function iterate(queue: TaskQueue, args: string[]): Promise<void> {
  const iterationTask = createTask("Iterate: OODA cycle", {}, 0, "worqload");
  queue.enqueue(iterationTask);
  const id = iterationTask.id;
  const shortId = id.slice(0, SHORT_ID_LENGTH);

  // Observe
  const obs = await collectObservation(queue, {}, id);
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
  queue.addLog(id, "act", decision);
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
}

export function formatObserveLog(obs: Observation): string {
  const parts: string[] = [];
  parts.push(`tasks: ${obs.tasks.length} active, ${obs.waitingHumanTasks.length} waiting_human`);
  parts.push(`feedback: ${obs.feedbackSummary.counts.new} new, ${obs.feedbackSummary.counts.acknowledged} acked`);
  parts.push(`missions: ${obs.activeMissions.length} active`);
  parts.push(`sources: ${obs.sourceResults.length} ran`);
  const principleCount = obs.principles ? obs.principles.split("\n").filter(l => l.startsWith("- ")).length : 0;
  parts.push(`principles: ${principleCount}`);
  return parts.join("; ");
}
