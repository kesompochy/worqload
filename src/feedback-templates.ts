import { join } from "path";
import { homedir } from "os";

export interface FeedbackTemplate {
  id: string;
  label: string;
  text: string;
}

export const FEEDBACK_TEMPLATE_PREFIX =
  "This text was inserted by worqload on behalf of the user. The user expects the following behaviour:\n";

export const DEFAULT_FEEDBACK_TEMPLATES: FeedbackTemplate[] = [
  {
    id: "no-edit",
    label: "Do not edit any code",
    text: "Do not edit any code. The user wants to have a discussion with you, not code changes. Keep your hands off the Edit tool and focus on the conversation. You may read code if you need material for the discussion. If you feel you are missing information, escalate immediately instead of deferring.",
  },
  {
    id: "no-push",
    label: "Do not push",
    text: "Do not push. Any git operation that touches the remote is forbidden. Pushing is absolutely unacceptable.",
  },
  {
    id: "answer-the-question",
    label: "Answer the question",
    text: "The user is asking a question. Answer the question directly and concisely, and do nothing else. Do not edit code, do not take actions beyond what is needed to answer. Submit your answer as a report.",
  },
];

const LEGACY_PREFIXES = [
  "This text was inserted by worqload on behalf of the user. The user expects the following behaviour:\n",
  "This text was inserted by worqload on behalf of the user. The user expects the following behaviour: ",
  "このテキストはworqloadがユーザーに代わって挿入した。ユーザーは以下の振る舞いを期待している:\n",
  "このテキストはworqloadがユーザーに代わって挿入した。ユーザーは以下の振る舞いを期待している: ",
];

export function stripLegacyPrefix(text: string): string {
  for (const p of LEGACY_PREFIXES) {
    if (text.startsWith(p)) return text.slice(p.length);
  }
  return text;
}

export function parseFeedbackTemplates(yamlText: string): FeedbackTemplate[] | null {
  const parsed = Bun.YAML.parse(yamlText) as unknown;
  if (parsed == null) return null;
  if (typeof parsed !== "object") {
    throw new Error("config: top level must be a YAML mapping");
  }
  const raw = (parsed as Record<string, unknown>).feedbackTemplates;
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    throw new Error("config: `feedbackTemplates` must be a list of { id, label, text } entries");
  }
  return raw.map((entry, index) => {
    if (entry == null || typeof entry !== "object") {
      throw new Error(`config: feedbackTemplates entry ${index} must be a mapping with id, label, and text`);
    }
    const { id, label, text } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id === "") {
      throw new Error(`config: feedbackTemplates entry ${index} is missing a non-empty id`);
    }
    if (typeof label !== "string" || label === "") {
      throw new Error(`config: feedbackTemplates entry ${index} is missing a non-empty label`);
    }
    if (typeof text !== "string" || text === "") {
      throw new Error(`config: feedbackTemplates entry ${index} is missing a non-empty text`);
    }
    const stripped = stripLegacyPrefix(text);
    return { id, label, text: stripped };
  });
}

export function mergeFeedbackTemplates(defaults: FeedbackTemplate[], overrides: FeedbackTemplate[]): FeedbackTemplate[] {
  const merged = [...defaults];
  for (const o of overrides) {
    const idx = merged.findIndex(t => t.id === o.id);
    if (idx >= 0) merged[idx] = o;
    else merged.push(o);
  }
  return merged;
}

export async function loadFeedbackTemplates(configPath: string): Promise<FeedbackTemplate[]> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return DEFAULT_FEEDBACK_TEMPLATES;
  const configured = parseFeedbackTemplates(await file.text());
  if (configured == null) return DEFAULT_FEEDBACK_TEMPLATES;
  return mergeFeedbackTemplates(DEFAULT_FEEDBACK_TEMPLATES, configured);
}
