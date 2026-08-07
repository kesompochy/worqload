// Thin wrapper around worqload server's internal API used by the agent-side
// CLI commands (`worqload report submit`, `worqload escalate submit`,
// `worqload feedback fetch`). Pure functions — no process.exit, no stdin —
// so they can be unit-tested.

export interface SubmitResult {
  filename: string;
  seq: number;
}

// A report held by revise mode on its first submission: not yet stored. The
// session is asked (via a queued feedback message) to revise and resubmit;
// `worqload report submit` reports this verdict back to the agent.
export interface ReportRevisionRequested {
  revisionRequested: true;
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

// Image attachments ride along a report as a multipart POST: the JSON body
// goes in a `payload` field, each image in its own `attachment` field. This
// avoids base64-inflating the binary the way a JSON-embedded image would.
async function postReportForm<T>(url: string, body: unknown, images: File[]): Promise<T> {
  const form = new FormData();
  form.set("payload", JSON.stringify(body));
  for (const image of images) form.append("attachment", image);
  const res = await fetch(url, { method: "POST", body: form });
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
  replyTo?: string,
  images: File[] = [],
): Promise<SubmitResult | ReportRevisionRequested> {
  const url = `${endpoint}/internal/sessions/${sessionId}/reports`;
  const body = replyTo ? { slug, content, replyTo } : { slug, content };
  type Result = SubmitResult | ReportRevisionRequested;
  return images.length > 0 ? postReportForm<Result>(url, body, images) : postJson<Result>(url, body);
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

export interface CommandApprovalResult extends SubmitResult {
  decision?: "approve" | "reject";
  feedbackContent?: string;
}

export async function requestCommandApproval(
  endpoint: string,
  sessionId: string,
  command: string,
  reason: string,
  sync = false,
  timeoutSeconds?: number,
): Promise<CommandApprovalResult> {
  const timeoutMs = typeof timeoutSeconds === "number" && timeoutSeconds > 0
    ? timeoutSeconds * 1000
    : undefined;
  return postJson<CommandApprovalResult>(
    `${endpoint}/internal/sessions/${sessionId}/command-approvals`,
    { command, ...(reason ? { reason } : {}), ...(sync ? { sync: true } : {}), ...(timeoutMs ? { timeoutMs } : {}) },
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

export interface FeedbackHistoryMessage {
  filename: string;
  content: string;
  status: "unread" | "read";
}

export interface FeedbackHistoryResult {
  messages: FeedbackHistoryMessage[];
}

export async function listFeedbackHistory(
  endpoint: string,
  sessionId: string,
): Promise<FeedbackHistoryResult> {
  const res = await fetch(`${endpoint}/internal/sessions/${sessionId}/feedback/history`);
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return (await res.json()) as FeedbackHistoryResult;
}

export interface FetchFeedbackByFilenameResult {
  message: FeedbackMessage;
}

export async function fetchFeedbackByFilename(
  endpoint: string,
  sessionId: string,
  filename: string,
): Promise<FetchFeedbackByFilenameResult> {
  const res = await fetch(`${endpoint}/internal/sessions/${sessionId}/feedback/by-filename/${encodeURIComponent(filename)}`);
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return (await res.json()) as FetchFeedbackByFilenameResult;
}
