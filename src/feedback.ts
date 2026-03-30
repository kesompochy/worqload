import { loadJsonFile, saveJsonFile } from "./utils/json-store";

const DEFAULT_FEEDBACK_PATH = ".worqload/feedback.json";

export type FeedbackStatus = "new" | "acknowledged" | "resolved";

export interface Feedback {
  id: string;
  from: string;
  message: string;
  status: FeedbackStatus;
  createdAt: string;
}

export async function loadFeedback(path: string = DEFAULT_FEEDBACK_PATH): Promise<Feedback[]> {
  return loadJsonFile<Feedback[]>(path, []);
}

export async function saveFeedback(items: Feedback[], path: string = DEFAULT_FEEDBACK_PATH): Promise<void> {
  await saveJsonFile(path, items);
}

export async function addFeedback(message: string, from: string, path: string = DEFAULT_FEEDBACK_PATH): Promise<Feedback> {
  const item: Feedback = {
    id: crypto.randomUUID(),
    from,
    message,
    status: "new",
    createdAt: new Date().toISOString(),
  };
  const items = await loadFeedback(path);
  items.push(item);
  await saveFeedback(items, path);
  return item;
}

export async function acknowledgeFeedback(id: string, path: string = DEFAULT_FEEDBACK_PATH): Promise<void> {
  const items = await loadFeedback(path);
  const item = items.find(f => f.id === id || f.id.startsWith(id));
  if (!item) throw new Error(`Feedback not found: ${id}`);
  item.status = "acknowledged";
  await saveFeedback(items, path);
}

export async function resolveFeedback(id: string, path: string = DEFAULT_FEEDBACK_PATH): Promise<void> {
  const items = await loadFeedback(path);
  const item = items.find(f => f.id === id || f.id.startsWith(id));
  if (!item) throw new Error(`Feedback not found: ${id}`);
  item.status = "resolved";
  await saveFeedback(items, path);
}

export async function removeFeedback(id: string, path: string = DEFAULT_FEEDBACK_PATH): Promise<void> {
  const items = await loadFeedback(path);
  const filtered = items.filter(f => f.id !== id && !f.id.startsWith(id));
  if (filtered.length === items.length) throw new Error(`Feedback not found: ${id}`);
  await saveFeedback(filtered, path);
}
