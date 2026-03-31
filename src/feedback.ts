import { join } from "path";
import { EntityStore } from "./utils/entity-store";
import { loadProjects } from "./projects";

const DEFAULT_FEEDBACK_PATH = ".worqload/feedback.json";

export type FeedbackStatus = "new" | "acknowledged" | "resolved";

export interface Feedback {
  id: string;
  from: string;
  message: string;
  status: FeedbackStatus;
  createdAt: string;
}

const store = new EntityStore<Feedback>(DEFAULT_FEEDBACK_PATH, "Feedback");

export async function loadFeedback(path: string = DEFAULT_FEEDBACK_PATH): Promise<Feedback[]> {
  return store.load(path);
}

export async function saveFeedback(items: Feedback[], path: string = DEFAULT_FEEDBACK_PATH): Promise<void> {
  await store.save(items, path);
}

export async function addFeedback(message: string, from: string, path: string = DEFAULT_FEEDBACK_PATH): Promise<Feedback> {
  const item: Feedback = {
    id: crypto.randomUUID(),
    from,
    message,
    status: "new",
    createdAt: new Date().toISOString(),
  };
  return store.add(item, path);
}

export async function acknowledgeFeedback(id: string, path: string = DEFAULT_FEEDBACK_PATH): Promise<void> {
  await store.update(id, { status: "acknowledged" }, path);
}

export async function resolveFeedback(id: string, path: string = DEFAULT_FEEDBACK_PATH): Promise<void> {
  await store.update(id, { status: "resolved" }, path);
}

export async function updateFeedbackMessage(id: string, message: string, path: string = DEFAULT_FEEDBACK_PATH): Promise<void> {
  await store.update(id, { message }, path);
}

export async function removeFeedback(id: string, path: string = DEFAULT_FEEDBACK_PATH): Promise<void> {
  await store.remove(id, path);
}

export interface FeedbackSummary {
  counts: Record<FeedbackStatus, number>;
  recentUnresolved: Feedback[];
  themes: string[];
}

export function summarizeFeedback(items: Feedback[]): FeedbackSummary {
  const counts: Record<FeedbackStatus, number> = { new: 0, acknowledged: 0, resolved: 0 };
  for (const item of items) {
    counts[item.status]++;
  }

  const unresolved = items
    .filter((f) => f.status !== "resolved")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recentUnresolved = unresolved.slice(0, 5);

  const themes: string[] = [];
  const bySender = new Map<string, Feedback[]>();
  for (const item of unresolved) {
    const group = bySender.get(item.from) || [];
    group.push(item);
    bySender.set(item.from, group);
  }
  for (const [sender, group] of bySender) {
    if (group.length >= 3) {
      themes.push(`${sender} から未解決フィードバックが ${group.length} 件`);
    }
  }

  return { counts, recentUnresolved, themes };
}

export interface DistillResult {
  distilledCount: number;
  rules: string[];
}

export async function distillFeedback(
  feedbackPath: string = DEFAULT_FEEDBACK_PATH,
  templatePath: string = ".claude/agents/worqload.md",
): Promise<DistillResult> {
  const items = await store.load(feedbackPath);
  const resolved = items.filter((f) => f.status === "resolved");

  if (resolved.length === 0) {
    return { distilledCount: 0, rules: [] };
  }

  const templateFile = Bun.file(templatePath);
  const templateContent = await templateFile.text();

  const rulesIndex = templateContent.indexOf("## Rules");
  if (rulesIndex === -1) {
    throw new Error("Agent template has no ## Rules section");
  }

  const rules = resolved.map((f) => f.message);
  const rulesBlock = rules.map((r) => `- ${r}`).join("\n") + "\n";

  const updatedContent = templateContent.trimEnd() + "\n" + rulesBlock;
  await Bun.write(templatePath, updatedContent);

  for (const f of resolved) {
    await store.remove(f.id, feedbackPath);
  }

  return { distilledCount: resolved.length, rules };
}

export async function sendFeedbackToProject(
  targetProjectName: string,
  message: string,
  from: string,
  projectsPath?: string,
): Promise<Feedback> {
  const projects = await loadProjects(projectsPath);
  const target = projects.find(p => p.name === targetProjectName);
  if (!target) {
    throw new Error(`Project not found: ${targetProjectName}`);
  }
  const targetFeedbackPath = join(target.path, DEFAULT_FEEDBACK_PATH);
  return addFeedback(message, from, targetFeedbackPath);
}
