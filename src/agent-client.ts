// Thin wrapper around worqload server's internal API used by the agent-side
// CLI commands (`worqload report submit`, `worqload escalate submit`,
// `worqload feedback fetch`). Pure functions — no process.exit, no stdin —
// so they can be unit-tested.

export interface SubmitResult {
  filename: string;
  seq: number;
}

// A report the rewriter judged not worth the human's time: stored nowhere,
// shown nowhere. `worqload report submit` reports this back to the agent.
export interface ReportSuppressed {
  suppressed: true;
}

// A report the rewriter judged a misfiled request for a decision: not stored.
// `worqload report submit` tells the agent to resubmit it as an escalation.
export interface ReportEscalateInstead {
  escalateInstead: true;
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
): Promise<SubmitResult | ReportSuppressed | ReportEscalateInstead> {
  const url = `${endpoint}/internal/sessions/${sessionId}/reports`;
  const body = replyTo ? { slug, content, replyTo } : { slug, content };
  type Result = SubmitResult | ReportSuppressed | ReportEscalateInstead;
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
