import type { Mission } from "./mission";
import type { Task, OodaPhase } from "./task";
import { HUMAN_REQUIRED_PREFIX, isTerminal } from "./task";
import { updateTask, load } from "./store";

export type OrientResult = "oriented" | "escalated" | "needs_principles";

export const ORIENT_ESCALATION_WINDOW = 5;

function phaseLog(phase: OodaPhase, content: string) {
  return { phase, content, timestamp: new Date().toISOString() };
}

function formatContextForOrient(context: Record<string, unknown>): string {
  const keys = Object.keys(context);
  if (keys.length === 0) return "";
  const parts: string[] = [];
  if (Array.isArray(context.observations)) {
    parts.push(context.observations.join("; "));
  }
  if (typeof context.feedbackId === "string") {
    parts.push(`feedback: ${context.feedbackId}`);
  }
  if (Array.isArray(context.feedbackIds)) {
    parts.push(`feedback: ${context.feedbackIds.join(", ")}`);
  }
  if (Array.isArray(context.principles)) {
    parts.push(`principles: ${context.principles.join(", ")}`);
  }
  if (parts.length === 0) {
    return JSON.stringify(context);
  }
  return parts.join("; ");
}

export function shouldForceEscalation(missionTasks: Task[], window: number = ORIENT_ESCALATION_WINDOW): boolean {
  const terminalTasks = missionTasks
    .filter(isTerminal)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  if (terminalTasks.length < window) return false;

  const recentTasks = terminalTasks.slice(0, window);
  const hasEscalation = recentTasks.some(t =>
    t.logs.some(l => l.phase === "orient" && l.content.includes(HUMAN_REQUIRED_PREFIX)));

  return !hasEscalation;
}

export async function orientTask(
  taskId: string,
  mission: Mission,
  storePath?: string,
): Promise<OrientResult> {
  if (mission.principles.length === 0) {
    await updateTask(taskId, (current) => ({
      status: "observing" as const,
      logs: [...current.logs, phaseLog("orient",
        `Main session must set mission principles for "${mission.name}" using: worqload mission principle ${mission.id} add <text>`)],
    }), storePath);
    return "needs_principles";
  }

  // Orient requires human expertise — force periodic escalation
  // Skip if this task already has a human answer (avoid re-escalation loop)
  const allTasks = await load(storePath);
  const currentTask = allTasks.find(t => t.id === taskId);
  const alreadyHasHumanAnswer = currentTask?.logs.some(
    l => l.phase === "orient" && !l.content.startsWith(HUMAN_REQUIRED_PREFIX),
  );
  const missionTasks = allTasks.filter(t => t.missionId === mission.id && t.id !== taskId);
  if (!alreadyHasHumanAnswer && shouldForceEscalation(missionTasks)) {
    await updateTask(taskId, (current) => ({
      status: "waiting_human" as const,
      logs: [...current.logs, phaseLog("orient",
        `${HUMAN_REQUIRED_PREFIX}Mission "${mission.name}": orient requires human expertise. No human-reviewed orient in recent ${ORIENT_ESCALATION_WINDOW} completed tasks.`)],
    }), storePath);
    return "escalated";
  }

  const principlesList = mission.principles.map(p => `- ${p}`).join("\n");
  await updateTask(taskId, (current) => {
    const taskTitle = current.title;
    const contextSummary = formatContextForOrient(current.context);
    const orientLines = [
      `Mission "${mission.name}" orient:`,
      `Task: ${taskTitle}`,
    ];
    if (contextSummary) {
      orientLines.push(`Context: ${contextSummary}`);
    }
    orientLines.push(`Principles:\n${principlesList}`);
    return {
      status: "orienting" as const,
      logs: [...current.logs, phaseLog("orient", orientLines.join("\n"))],
    };
  }, storePath);
  return "oriented";
}
