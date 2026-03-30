import { EntityStore } from "./utils/entity-store";

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
