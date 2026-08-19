import { join } from "path";
import { homedir } from "os";

export interface FeedbackTemplate {
  id: string;
  label: string;
  text: string;
}

export const DEFAULT_FEEDBACK_TEMPLATES: FeedbackTemplate[] = [
  {
    id: "no-edit",
    label: "Do not edit any code",
    text: "This text was inserted by worqload on behalf of the user. The user expects the following behaviour:\nDo not edit any code. The user wants to have a discussion with you, not code changes. Keep your hands off the Edit tool and focus on the conversation. You may read code if you need material for the discussion. If you feel you are missing information, escalate immediately instead of deferring.",
  },
  {
    id: "no-push",
    label: "Do not push",
    text: "This text was inserted by worqload on behalf of the user. The user expects the following behaviour:\nDo not push. Any git operation that touches the remote is forbidden. Pushing is absolutely unacceptable.",
  },
];

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
    return { id, label, text };
  });
}

export async function loadFeedbackTemplates(configPath: string): Promise<FeedbackTemplate[]> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return DEFAULT_FEEDBACK_TEMPLATES;
  const configured = parseFeedbackTemplates(await file.text());
  return configured ?? DEFAULT_FEEDBACK_TEMPLATES;
}
