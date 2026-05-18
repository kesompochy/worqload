import { test, expect, afterEach } from "bun:test";
import { startServer } from "./web-server";
import { submitReport, submitEscalation, requestCommandApproval, fetchFeedback } from "./agent-client";
import { cleanupAll, fakeWorktreeOps, inProcessHostLauncher, makeTmpDir, trackCleanup } from "./test-helpers";

afterEach(cleanupAll);

const TEST_BASE = "trunk";

async function bootAndCreateSession(): Promise<{ endpoint: string; sessionId: string }> {
  const repoDir = makeTmpDir("repo");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    // Pass-through: these tests assert report bookkeeping, not prose, and must
    // not spawn the real claude the production rewriter would.
    reportRewriter: async raw => raw,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const endpoint = `http://127.0.0.1:${started.server.port}`;
  const created = await fetch(`${endpoint}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x", baseBranch: TEST_BASE }),
  }).then(r => r.json());
  return { endpoint, sessionId: created.meta.id };
}

test("submitReport posts a numbered report", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();

  const r = await submitReport(endpoint, sessionId, "plan", "this is the plan");
  expect(r.filename).toBe("001-plan.md");
  expect(r.seq).toBe(1);
});

test("submitReport --re links the report to a feedback message", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();
  await fetch(`${endpoint}/sessions/${sessionId}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "please fix the parser", slug: "feedback" }),
  });

  const r = await submitReport(endpoint, sessionId, "fix", "fixed the parser", "001-feedback.md");
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
