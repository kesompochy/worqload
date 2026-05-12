// Thin wrapper around worqload server's internal API used by the agent-side
// CLI commands (`worqload report submit`, `worqload escalate submit`,
// `worqload feedback fetch`). Pure functions — no process.exit, no stdin —
// so they can be unit-tested.

export interface SubmitResult {
  filename: string;
  seq: number;
}

export interface FeedbackMessage {
  filename: string;
  content: string;
}

export interface FetchFeedbackResult {
  messages: FeedbackMessage[];
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function submitReport(
  endpoint: string,
  sessionId: string,
  slug: string,
  content: string,
): Promise<SubmitResult> {
  return postJson<SubmitResult>(
    `${endpoint}/internal/sessions/${sessionId}/reports`,
    { slug, content },
  );
}

export async function submitEscalation(
  endpoint: string,
  sessionId: string,
  slug: string,
  content: string,
): Promise<SubmitResult> {
  return postJson<SubmitResult>(
    `${endpoint}/internal/sessions/${sessionId}/escalations`,
    { slug, content },
  );
}

export async function requestCommandApproval(
  endpoint: string,
  sessionId: string,
  command: string,
  reason: string,
): Promise<SubmitResult> {
  return postJson<SubmitResult>(
    `${endpoint}/internal/sessions/${sessionId}/command-approvals`,
    { command, ...(reason ? { reason } : {}) },
  );
}

export async function fetchFeedback(
  endpoint: string,
  sessionId: string,
): Promise<FetchFeedbackResult> {
  const res = await fetch(`${endpoint}/internal/sessions/${sessionId}/feedback`);
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return (await res.json()) as FetchFeedbackResult;
}
