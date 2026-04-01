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

export interface FeedbackTheme {
  description: string;
  feedbackIds: string[];
}

export interface FeedbackSummary {
  counts: Record<FeedbackStatus, number>;
  recentUnresolved: Feedback[];
  themes: FeedbackTheme[];
  unresolvedIds: string[];
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

  const themes: FeedbackTheme[] = [];
  const bySender = new Map<string, Feedback[]>();
  for (const item of unresolved) {
    const group = bySender.get(item.from) || [];
    group.push(item);
    bySender.set(item.from, group);
  }
  for (const [sender, group] of bySender) {
    if (group.length >= 3) {
      themes.push({
        description: `${sender} から未解決フィードバックが ${group.length} 件`,
        feedbackIds: group.map(f => f.id),
      });
    }
  }

  return { counts, recentUnresolved, themes, unresolvedIds: unresolved.map(f => f.id) };
}

export interface DistillResult {
  distilledCount: number;
  rules: string[];
  pendingVerification: DistilledRule[];
}

export type DistilledRuleStatus = "pending_verification" | "verified" | "task_created";

export interface DistilledRule {
  id: string;
  rule: string;
  feedbackIds: string[];
  distilledAt: string;
  status: DistilledRuleStatus;
}

const DEFAULT_DISTILLED_RULES_PATH = ".worqload/distilled-rules.json";
const distilledRuleStore = new EntityStore<DistilledRule>(DEFAULT_DISTILLED_RULES_PATH, "DistilledRule");

export async function loadDistilledRules(path: string = DEFAULT_DISTILLED_RULES_PATH): Promise<DistilledRule[]> {
  return distilledRuleStore.load(path);
}

export async function markRuleTaskCreated(id: string, path: string = DEFAULT_DISTILLED_RULES_PATH): Promise<void> {
  await distilledRuleStore.update(id, { status: "task_created" }, path);
}

export type CodeChangeChecker = (since: string) => Promise<boolean>;

export async function hasCodeChangeSince(since: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["git", "log", "--oneline", `--since=${since}`, "--", "src/", "*.test.*"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export interface VerifyResult {
  verified: DistilledRule[];
  unverified: DistilledRule[];
}

export async function verifyDistilledRules(
  rulesPath: string = DEFAULT_DISTILLED_RULES_PATH,
  checkCodeChange: CodeChangeChecker = hasCodeChangeSince,
): Promise<VerifyResult> {
  const rules = await distilledRuleStore.load(rulesPath);
  const checkable = rules.filter(r => r.status === "pending_verification" || r.status === "task_created");

  const verified: DistilledRule[] = [];
  const unverified: DistilledRule[] = [];

  for (const rule of checkable) {
    const hasChanges = await checkCodeChange(rule.distilledAt);
    if (hasChanges) {
      await distilledRuleStore.update(rule.id, { status: "verified" }, rulesPath);
      verified.push({ ...rule, status: "verified" });
    } else if (rule.status === "pending_verification") {
      unverified.push(rule);
    }
  }

  return { verified, unverified };
}

const ENGLISH_DIRECTIVE_PATTERN = /^(always|never|do not|don't|must|should|use|run|write|add|remove|delete|avoid|ensure|make sure|keep|stop|include|exclude|set|check|verify|update|create|fix|follow|apply|disable|enable|prefer|require|allow|forbid|prohibit)\b/i;

const ENGLISH_CONTAINS_DIRECTIVE_PATTERN = /\b(should|must|shall|always|never)\b/i;

const JAPANESE_DIRECTIVE_PATTERN = /(べき|べきだ|しろ|こと|てくれ|てください|ないでください|するな|しなさい|てほしい|すべし)$/;

const JAPANESE_CONTAINS_DIRECTIVE_PATTERN = /方がいい|べき|なければならない|ないといけない|してはいけない/;

function isQuestion(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (trimmed.endsWith("?") || trimmed.endsWith("？")) return true;
  if (/か？$|ですか$|ますか$/.test(trimmed)) return true;
  if (/^(why|how|what|when|where|who|which|is|are|do|does|did|can|could|would|should)\b.*\?$/i.test(trimmed)) return true;
  return false;
}

function isActionableDirective(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (trimmed.length === 0) return false;
  if (isQuestion(trimmed)) return false;
  if (ENGLISH_DIRECTIVE_PATTERN.test(trimmed)) return true;
  if (ENGLISH_CONTAINS_DIRECTIVE_PATTERN.test(trimmed)) return true;
  if (JAPANESE_DIRECTIVE_PATTERN.test(trimmed)) return true;
  if (JAPANESE_CONTAINS_DIRECTIVE_PATTERN.test(trimmed)) return true;
  return false;
}

function splitSentences(message: string): string[] {
  // Split on period followed by space or end, or Japanese period
  return message
    .split(/(?<=\.)\s+|。/)
    .map((s) => s.replace(/\.$/, "").trim())
    .filter((s) => s.length > 0);
}

export function extractActionableRules(message: string): string[] {
  const sentences = splitSentences(message);
  const rules: string[] = [];
  for (const sentence of sentences) {
    if (isActionableDirective(sentence)) {
      rules.push(sentence);
    }
  }
  return rules;
}

export function extractObservationalContent(message: string): string[] {
  const sentences = splitSentences(message);
  return sentences.filter(s => {
    const trimmed = s.trim();
    return trimmed.length > 0 && !isQuestion(trimmed) && !isActionableDirective(trimmed);
  });
}

function extractExistingRules(templateContent: string): Set<string> {
  const existingRules = new Set<string>();
  const ruleLinePattern = /^- (.+)$/gm;
  let match;
  while ((match = ruleLinePattern.exec(templateContent)) !== null) {
    existingRules.add(normalizeRuleForComparison(match[1]));
  }
  return existingRules;
}

function normalizeRuleForComparison(rule: string): string {
  return rule.toLowerCase().replace(/[.\s]+$/g, "").trim();
}

export async function distillFeedback(
  feedbackPath: string = DEFAULT_FEEDBACK_PATH,
  templatePath: string = ".claude/skills/worqload/SKILL.md",
  distilledRulesPath: string = DEFAULT_DISTILLED_RULES_PATH,
): Promise<DistillResult> {
  const items = await store.load(feedbackPath);
  const resolved = items.filter((f) => f.status === "resolved");

  if (resolved.length === 0) {
    return { distilledCount: 0, rules: [], pendingVerification: [] };
  }

  const templateFile = Bun.file(templatePath);
  const templateContent = await templateFile.text();

  const rulesIndex = templateContent.indexOf("## Rules");
  if (rulesIndex === -1) {
    throw new Error("Agent template has no ## Rules section");
  }

  const existingRules = extractExistingRules(templateContent);

  const allRules: string[] = [];
  const ruleOrigins: { rule: string; feedbackId: string }[] = [];
  for (const feedback of resolved) {
    const extracted = extractActionableRules(feedback.message);
    for (const rule of extracted) {
      const normalized = normalizeRuleForComparison(rule);
      if (!existingRules.has(normalized)) {
        allRules.push(rule);
        existingRules.add(normalized);
        ruleOrigins.push({ rule, feedbackId: feedback.id });
      }
    }
  }

  if (allRules.length > 0) {
    const rulesBlock = allRules.map((r) => `- ${r}`).join("\n") + "\n";
    const updatedContent = templateContent.trimEnd() + "\n" + rulesBlock;
    await Bun.write(templatePath, updatedContent);
  }

  const now = new Date().toISOString();
  const pendingVerification: DistilledRule[] = [];
  for (const { rule, feedbackId } of ruleOrigins) {
    const distilledRule: DistilledRule = {
      id: crypto.randomUUID(),
      rule,
      feedbackIds: [feedbackId],
      distilledAt: now,
      status: "pending_verification",
    };
    await distilledRuleStore.add(distilledRule, distilledRulesPath);
    pendingVerification.push(distilledRule);
  }

  for (const f of resolved) {
    await store.remove(f.id, feedbackPath);
  }

  return { distilledCount: allRules.length, rules: allRules, pendingVerification };
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
