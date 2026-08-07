import { test, expect, afterEach } from "bun:test";
import { startServer } from "./web-server";
import { submitReport, submitEscalation, requestCommandApproval, fetchFeedback } from "./agent-client";
import { cleanupAll, fakeWorktreeOps, inProcessHostLauncher, makeTmpDir, trackCleanup } from "./test-helpers";

afterEach(cleanupAll);

const TEST_BASE = "trunk";

async function bootAndCreateSession(
  // Revise mode is off by default; a test that needs the first submission
  // bounced must opt the session in.
  { enableReviseMode = false }: { enableReviseMode?: boolean } = {},
): Promise<{ endpoint: string; sessionId: string }> {
  const repoDir = makeTmpDir("repo");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const endpoint = `http://127.0.0.1:${started.server.port}`;
  const created = await fetch(`${endpoint}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x", baseBranch: TEST_BASE }),
  }).then(r => r.json());
  const sessionId = created.meta.id;
  if (enableReviseMode) {
    await fetch(`${endpoint}/sessions/${sessionId}/revise-mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
  }
  return { endpoint, sessionId };
}

test("submitReport posts a numbered report", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();

  const r = await submitReport(endpoint, sessionId, "plan", "this is the plan");
  if (!("filename" in r)) throw new Error("report unexpectedly not stored");
  expect(r.filename).toBe("001-plan.md");
  expect(r.seq).toBe(1);
});

test("submitReport reports a revision-requested verdict instead of a filename on the first submission", async () => {
  // Revise mode holds the first submission and asks the session to revise it;
  // the server stores nothing and the agent is told to resubmit.
  const { endpoint, sessionId } = await bootAndCreateSession({ enableReviseMode: true });
  const r = await submitReport(endpoint, sessionId, "draft", "初稿");
  expect(r).toEqual({ revisionRequested: true });

  // The resubmission goes through and is stored.
  const resubmitted = await submitReport(endpoint, sessionId, "draft", "推敲した本文");
  if (!("filename" in resubmitted)) throw new Error("resubmission must be stored");
  expect(resubmitted.filename).toBe("001-draft.md");
});

test("submitReport --re links the report to a feedback message", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();
  await fetch(`${endpoint}/sessions/${sessionId}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "please fix the parser", slug: "feedback" }),
  });

  const r = await submitReport(endpoint, sessionId, "fix", "fixed the parser", "001-feedback.md");
  if (!("filename" in r)) throw new Error("report unexpectedly not stored");
  expect(r.filename).toBe("001-fix.md");

  const reports = await fetch(`${endpoint}/sessions/${sessionId}/reports`).then(res => res.json());
  expect(reports.reports[0].replyTo).toBe("001-feedback.md");

  // A report without --re carries no replyTo.
  await submitReport(endpoint, sessionId, "more", "more work");
  const after = await fetch(`${endpoint}/sessions/${sessionId}/reports`).then(res => res.json());
  expect(after.reports.find((x: { filename: string }) => x.filename === "002-more.md").replyTo).toBeUndefined();
});

test("submitReport --re rejects a feedback filename that does not exist", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();
  await expect(submitReport(endpoint, sessionId, "fix", "x", "099-nope.md")).rejects.toThrow();
});

test("submitReport --re rejects a malformed feedback filename", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();
  await expect(submitReport(endpoint, sessionId, "fix", "x", "../../etc/passwd")).rejects.toThrow();
});

test("submitReport uploads image attachments alongside the report", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const image = new File([png], "shot.png", { type: "image/png" });
  const r = await submitReport(endpoint, sessionId, "done", "see the screenshot", undefined, [image]);
  if (!("filename" in r)) throw new Error("report unexpectedly not stored");
  expect(r.filename).toBe("001-done.md");

  const reports = await fetch(`${endpoint}/sessions/${sessionId}/reports`).then(res => res.json());
  expect(reports.reports[0].attachments).toEqual(["01-shot.png"]);

  const bytes = await fetch(`${endpoint}/sessions/${sessionId}/reports/001-done.md/attachments/01-shot.png`);
  expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(png);
});

test("submitEscalation flips status to waiting_human", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();

  const e = await submitEscalation(endpoint, sessionId, "which-lib", "X or Y?");
  expect(e.filename).toBe("001-which-lib.md");

  const detail = await fetch(`${endpoint}/sessions/${sessionId}`).then(r => r.json());
  expect(detail.meta.status).toBe("waiting_human");
});

test("requestCommandApproval files a command-approval escalation", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();

  const r = await requestCommandApproval(endpoint, sessionId, "npm publish", "release it");
  expect(r.filename).toBe("001-command-approval.md");

  const detail = await fetch(`${endpoint}/sessions/${sessionId}`).then(r => r.json());
  expect(detail.meta.status).toBe("waiting_human");

  const asking = await fetch(`${endpoint}/sessions/${sessionId}/asking`).then(r => r.json());
  expect(asking.asking[0].command).toBe("npm publish");
});

test("sync requestCommandApproval blocks until resolved and returns the result", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();

  const syncPromise = requestCommandApproval(endpoint, sessionId, "echo sync-test", "verify sync", true);

  let askingFilename: string;
  while (true) {
    const asking = await fetch(`${endpoint}/sessions/${sessionId}/asking`).then(r => r.json());
    if (asking.asking.length > 0) {
      askingFilename = asking.asking[0].filename;
      break;
    }
    await Bun.sleep(5);
  }

  await fetch(`${endpoint}/sessions/${sessionId}/escalations/${askingFilename}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });

  const result = await syncPromise;
  expect(result.decision).toBe("approve");
  expect(result.feedbackContent).toContain("echo sync-test");
  expect(result.feedbackContent).toContain("sync-test");

  const feedback = await fetchFeedback(endpoint, sessionId);
  expect(feedback.messages).toEqual([]);
});

test("sync requestCommandApproval returns rejection", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();

  const syncPromise = requestCommandApproval(endpoint, sessionId, "rm -rf /", "cleanup", true);

  let askingFilename: string;
  while (true) {
    const asking = await fetch(`${endpoint}/sessions/${sessionId}/asking`).then(r => r.json());
    if (asking.asking.length > 0) {
      askingFilename = asking.asking[0].filename;
      break;
    }
    await Bun.sleep(5);
  }

  await fetch(`${endpoint}/sessions/${sessionId}/escalations/${askingFilename}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "reject", content: "too dangerous" }),
  });

  const result = await syncPromise;
  expect(result.decision).toBe("reject");
  expect(result.feedbackContent).toContain("rejected");
  expect(result.feedbackContent).toContain("too dangerous");
});

test("fetchFeedback returns and drains the inbox", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();

  await fetch(`${endpoint}/sessions/${sessionId}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "hi", slug: "say-hi" }),
  });

  const first = await fetchFeedback(endpoint, sessionId);
  expect(first.messages).toHaveLength(1);
  expect(first.messages[0].content).toBe("hi");

  // second fetch returns empty (already drained)
  const second = await fetchFeedback(endpoint, sessionId);
  expect(second.messages).toEqual([]);
});

test("submitReport throws on non-existent session", async () => {
  const { endpoint } = await bootAndCreateSession();

  await expect(submitReport(endpoint, "nonexistent-session-id", "x", "y")).rejects.toThrow();
});
