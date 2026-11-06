import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { listAllFeedback, listCancellations, listPolishes } from "./archive-store";
import { readEvents } from "./event-log";
import type { PolishResult, ReportPolisher, ReportPolishRequest } from "./report-polish";
import type { ReportJudge, ReportJudgeRequest } from "./report-judge";
import { loadSessionMeta, saveSessionMeta } from "./session";
import { cleanupAll, fakeWorktreeOps, inProcessHostLauncher, makeTmpDir, trackCleanup } from "./test-helpers";
import { startServer } from "./web-server";

afterEach(cleanupAll);

const TEST_BASE = "trunk";
const CLAUDE_CONVERSATION_ID = "5d0c8a7e-2b1f-4e3d-9c8b-7a6f5e4d3c2b";

function polishedFlag(sessionsDir: string, sessionId: string, filename: string): unknown {
  const metaPath = join(sessionsDir, sessionId, "reports", filename.replace(/\.md$/, ".meta.json"));
  return existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")).polished : undefined;
}

async function bootServer(repoDir: string, extra: Partial<Parameters<typeof startServer>[0]> = {}) {
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    configPath: join(repoDir, "no-such-worqload-config.yaml"),
    archiveDbPath: null,
    ...extra,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  return { ...started, baseUrl: `http://127.0.0.1:${started.server.port}` };
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A polisher whose every call blocks until the test releases it, so a test can
// observe the server between accepting a draft and storing its polish.
function gatedPolisher(polish: (request: ReportPolishRequest) => string | PolishResult) {
  const requests: ReportPolishRequest[] = [];
  const releases: (() => void)[] = [];
  const polisher: ReportPolisher = async (request) => {
    requests.push(request);
    await new Promise<void>(resolve => releases.push(resolve));
    const outcome = polish(request);
    return typeof outcome === "string" ? { report: outcome } : outcome;
  };
  return {
    polisher,
    requests,
    async release(index: number) {
      while (releases.length <= index) await Bun.sleep(5);
      releases[index]();
    },
  };
}

async function createClaudeSession(baseUrl: string, ctx: Awaited<ReturnType<typeof bootServer>>["ctx"], body: Record<string, unknown> = {}) {
  const created = (await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE, ...body }).then(r => r.json())).meta;
  const meta = await loadSessionMeta(created.id, ctx.sessionsDir);
  await saveSessionMeta({ ...meta!, agentSessionId: CLAUDE_CONVERSATION_ID }, ctx.sessionsDir);
  return created;
}

async function storedReports(baseUrl: string, sessionId: string): Promise<{ filename: string; content: string }[]> {
  return (await fetch(`${baseUrl}/sessions/${sessionId}/reports`).then(r => r.json())).reports;
}

async function waitFor(condition: () => Promise<boolean> | boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitForReports(baseUrl: string, sessionId: string, count: number) {
  for (let i = 0; i < 400; i++) {
    const reports = await storedReports(baseUrl, sessionId);
    if (reports.length >= count) return reports;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${count} reports`);
}

test("a claude session's report is accepted at once and stored as the fork's polished text", async () => {
  const gate = gatedPolisher(() => "推敲された本文");
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  const res = await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "書き手の原稿" });
  expect(await res.json()).toEqual({ polishing: true });
  expect(await storedReports(baseUrl, session.id)).toEqual([]);

  await gate.release(0);
  const [stored] = await waitForReports(baseUrl, session.id, 1);
  expect(stored.content).toBe("推敲された本文");
  expect(gate.requests[0].draft).toBe("書き手の原稿");
  expect(gate.requests[0].cwd).toBe(session.worktreePath);
});

test("GET /sessions lists the drafts waiting for their polish until each is stored", async () => {
  const gate = gatedPolisher(r => r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);
  const polishing = async () =>
    (await fetch(`${baseUrl}/sessions`).then(r => r.json())).sessions.find((s: { id: string }) => s.id === session.id).polishing;

  const before = Date.now();
  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "原稿" });
  await postJson(baseUrl, `/internal/sessions/${session.id}/escalations`, { slug: "ask", content: "質問" });
  const listed = await polishing();
  expect(listed.map((p: { kind: string; slug: string }) => [p.kind, p.slug])).toEqual([["report", "plan"], ["escalation", "ask"]]);
  for (const p of listed as { since: string }[]) {
    expect(Date.parse(p.since)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(p.since)).toBeLessThanOrEqual(Date.now());
  }

  await gate.release(0);
  await waitForReports(baseUrl, session.id, 1);
  await waitFor(async () => (await polishing()).length === 1, "the stored report to leave the list");
  expect((await polishing())[0].slug).toBe("ask");
});


// Collects the sidebar-wide activity stream's messages.
async function openActivityStream(baseUrl: string) {
  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/activity/stream`);
  const messages: { sessionId: string; agentTurn: string; polishing: { kind: string; slug: string; since: string }[] }[] = [];
  ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
  trackCleanup(() => ws.close());
  return messages;
}

test("the activity stream announces a draft entering and leaving its polish", async () => {
  const gate = gatedPolisher(r => r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);
  const messages = await openActivityStream(baseUrl);
  const slugs = () => messages.filter(m => m.sessionId === session.id).map(m => m.polishing.map(p => p.slug));

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "原稿" });
  await waitFor(() => slugs().length >= 1, "the polish to be announced");
  expect(slugs()).toEqual([["plan"]]);

  await gate.release(0);
  await waitFor(() => slugs().length >= 2, "the stored polish to be announced");
  expect(slugs()).toEqual([["plan"], []]);
});

test("the fork resumes the writer's claude conversation with the writer's model", async () => {
  const gate = gatedPolisher(r => r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx, { model: "opus" });

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "書き手の原稿" });
  await gate.release(0);
  await waitForReports(baseUrl, session.id, 1);
  const argv = gate.requests[0].spawnCommand;
  expect(argv.slice(-3)).toEqual(["--resume", CLAUDE_CONVERSATION_ID, "--fork-session"]);
  expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
});

test("a polish sends nothing to the writer's inbox", async () => {
  const gate = gatedPolisher(() => "推敲された本文");
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "書き手の原稿" });
  await gate.release(0);
  await waitFor(async () => ctx.reportPolishDrains.size === 0 && (await storedReports(baseUrl, session.id)).length === 1, "the polish to finish");

  const fetched = (await fetch(`${baseUrl}/internal/sessions/${session.id}/feedback`).then(r => r.json())).messages;
  expect(fetched).toEqual([]);
});

test("a session's polishes run one at a time", async () => {
  const gate = gatedPolisher(r => `推敲版: ${r.draft}`);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "one", content: "原稿1" });
  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "two", content: "原稿2" });
  await waitFor(() => gate.requests.length === 1, "the first polish to start");
  await Bun.sleep(50);
  expect(gate.requests).toHaveLength(1);

  await gate.release(0);
  await gate.release(1);
  await waitFor(() => ctx.reportPolishDrains.size === 0, "both polishes to finish");
  expect(gate.requests[1].draft).toBe("推敲版: 原稿1\n\n原稿2");
});

test("a codex session's report is stored as submitted without a polish", async () => {
  const gate = gatedPolisher(() => "使われないはずの推敲");
  const { baseUrl } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const created = (await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE, agentName: "codex" }).then(r => r.json())).meta;

  const res = await postJson(baseUrl, `/internal/sessions/${created.id}/reports`, { slug: "plan", content: "codex の原稿" });
  expect((await res.json()).filename).toBeDefined();
  expect((await storedReports(baseUrl, created.id)).map(r => r.content)).toEqual(["codex の原稿"]);
  expect(gate.requests).toEqual([]);
});

test("a claude session whose 推敲モード is turned off stores its report as submitted without a polish", async () => {
  const gate = gatedPolisher(() => "使われないはずの推敲");
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  const toggled = await postJson(baseUrl, `/sessions/${session.id}/report-polish`, { enabled: false });
  expect((await toggled.json()).meta.reportPolishDisabled).toBe(true);

  const res = await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "書き手の原稿" });
  expect((await res.json()).filename).toBeDefined();
  expect((await storedReports(baseUrl, session.id)).map(r => r.content)).toEqual(["書き手の原稿"]);
  expect(gate.requests).toEqual([]);
});

test("turning 推敲モード back on polishes the session's next report", async () => {
  const gate = gatedPolisher(() => "推敲された本文");
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/sessions/${session.id}/report-polish`, { enabled: false });
  const toggled = await postJson(baseUrl, `/sessions/${session.id}/report-polish`, { enabled: true });
  expect((await toggled.json()).meta.reportPolishDisabled).toBeUndefined();

  const res = await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "書き手の原稿" });
  expect(await res.json()).toEqual({ polishing: true });
});

test("the 推敲モード toggle rejects a body without a boolean", async () => {
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"));
  const session = await createClaudeSession(baseUrl, ctx);

  const res = await postJson(baseUrl, `/sessions/${session.id}/report-polish`, { enabled: "no" });
  expect(res.status).toBe(400);
});

test("a draft accepted before a server restart is polished and stored by the next server", async () => {
  const repoDir = makeTmpDir("repo");
  const never: ReportPolisher = () => new Promise(() => {});
  const first = await bootServer(repoDir, { reportPolisher: never });
  const session = await createClaudeSession(first.baseUrl, first.ctx);
  await postJson(first.baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "再起動をまたぐ原稿" });
  await first.shutdown({ killHosts: true });

  const second = await bootServer(repoDir, { reportPolisher: async r => ({ report: `推敲版: ${r.draft}` }) });
  const [stored] = await waitForReports(second.baseUrl, session.id, 1);
  expect(stored.content).toBe("推敲版: 再起動をまたぐ原稿");
});

test("a polished report keeps the images attached to its draft", async () => {
  const gate = gatedPolisher(() => "推敲された本文");
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const form = new FormData();
  form.set("payload", JSON.stringify({ slug: "shot", content: "画像付きの原稿" }));
  form.append("attachment", new File([png], "shot.png", { type: "image/png" }));
  await fetch(`${baseUrl}/internal/sessions/${session.id}/reports`, { method: "POST", body: form });
  await gate.release(0);
  await waitForReports(baseUrl, session.id, 1);

  const [stored] = (await fetch(`${baseUrl}/sessions/${session.id}/reports`).then(r => r.json())).reports;
  expect(stored.attachments).toHaveLength(1);
  const image = await fetch(`${baseUrl}/sessions/${session.id}/reports/${stored.filename}/attachments/${stored.attachments[0]}`);
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
});

test("a withdrawn report is not stored and is kept for the human to inspect", async () => {
  const gate = gatedPolisher(() => ({ withdrawnReason: "人間の知っていることを何も変えない" }));
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "noop", content: "取り下げられる原稿" });
  await gate.release(0);
  await waitFor(async () => (await readEvents(session.id, 1, ctx.sessionsDir)).some(e => e.kind === "report_withdrawn"), "the withdrawal");

  expect(await storedReports(baseUrl, session.id)).toEqual([]);
  const withdrawn = (await readEvents(session.id, 1, ctx.sessionsDir)).find(e => e.kind === "report_withdrawn")!;
  expect(withdrawn.payload).toMatchObject({ slug: "noop", reason: "人間の知っていることを何も変えない" });
  const kept = readdirSync(join(ctx.sessionsDir, session.id, "report-polish-withdrawn"));
  expect(kept).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(ctx.sessionsDir, session.id, "report-polish-withdrawn", kept[0]), "utf8")))
    .toMatchObject({ slug: "noop", draft: "取り下げられる原稿", reason: "人間の知っていることを何も変えない" });

  const fetched = (await fetch(`${baseUrl}/internal/sessions/${session.id}/feedback`).then(r => r.json())).messages;
  expect(fetched).toEqual([]);
});

test("a returned report is not stored, is kept for the human, and reaches the writer with what is missing", async () => {
  const gate = gatedPolisher(() => ({ returnedReason: "原因の断定に、ログを確かめた跡がない" }));
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "cause", content: "差し戻される原稿" });
  await gate.release(0);
  await waitFor(async () => (await readEvents(session.id, 1, ctx.sessionsDir)).some(e => e.kind === "report_returned"), "the return");

  expect(gate.requests[0].allowReturn).toBe(true);
  expect(await storedReports(baseUrl, session.id)).toEqual([]);
  const returned = (await readEvents(session.id, 1, ctx.sessionsDir)).find(e => e.kind === "report_returned")!;
  expect(returned.payload).toMatchObject({ slug: "cause", reason: "原因の断定に、ログを確かめた跡がない" });
  const kept = readdirSync(join(ctx.sessionsDir, session.id, "report-polish-returned"));
  expect(kept).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(ctx.sessionsDir, session.id, "report-polish-returned", kept[0]), "utf8")))
    .toMatchObject({ slug: "cause", draft: "差し戻される原稿", reason: "原因の断定に、ログを確かめた跡がない" });

  const fetched = (await fetch(`${baseUrl}/internal/sessions/${session.id}/feedback`).then(r => r.json())).messages;
  expect(fetched).toHaveLength(1);
  expect(fetched[0].content).toContain("原因の断定に、ログを確かめた跡がない");
  expect(fetched[0].content).toContain("差し戻される原稿");
  expect(fetched[0].content).toContain("--slug cause");
  expect(fetched[0].content).not.toContain("{{");
});

test("a report resubmitted after a return may not be returned again", async () => {
  const gate = gatedPolisher(r => r.allowReturn ? { returnedReason: "調査がない" } : r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "cause", content: "最初の原稿" });
  await gate.release(0);
  await waitFor(async () => (await readEvents(session.id, 1, ctx.sessionsDir)).some(e => e.kind === "report_returned"), "the return");
  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "cause", content: "調べ直した原稿" });
  await gate.release(1);

  const [stored] = await waitForReports(baseUrl, session.id, 1);
  expect(stored.content).toBe("調べ直した原稿");
  expect(gate.requests[1].allowReturn).toBe(false);
});

test("a changed polish is stored as the polished text alone and marked polished in its meta", async () => {
  const gate = gatedPolisher(() => "推敲された本文\n2 行目");
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "書き手の原稿" });
  await gate.release(0);
  const [listed] = await waitForReports(baseUrl, session.id, 1);

  const reportsDir = join(ctx.sessionsDir, session.id, "reports");
  expect(readFileSync(join(reportsDir, listed.filename), "utf8")).toBe("推敲された本文\n2 行目");
  expect(JSON.parse(readFileSync(join(reportsDir, listed.filename.replace(/\.md$/, ".meta.json")), "utf8")).polished).toBe(true);
});

test("a polish that leaves the draft unchanged is not marked polished", async () => {
  const gate = gatedPolisher(r => r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "書き手の原稿" });
  await gate.release(0);
  const [listed] = await waitForReports(baseUrl, session.id, 1);
  expect(readFileSync(join(ctx.sessionsDir, session.id, "reports", listed.filename), "utf8")).toBe("書き手の原稿");
  expect(polishedFlag(ctx.sessionsDir, session.id, listed.filename)).toBeUndefined();
});

test("a polish that only trims the draft's surrounding whitespace is stored as the draft, not marked polished", async () => {
  // The fork's report block is read trimmed, while drafts written from a file
  // end with a newline.
  const gate = gatedPolisher(r => r.draft.trim());
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "書き手の原稿\n" });
  await gate.release(0);
  const [listed] = await waitForReports(baseUrl, session.id, 1);
  expect(readFileSync(join(ctx.sessionsDir, session.id, "reports", listed.filename), "utf8")).toBe("書き手の原稿\n");
  expect(polishedFlag(ctx.sessionsDir, session.id, listed.filename)).toBeUndefined();
});

test("a failed polish of a draft ending with a newline is stored as the draft, not marked polished", async () => {
  const gate = gatedPolisher(r => r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "書き手の原稿\n" });
  await gate.release(0);
  const [listed] = await waitForReports(baseUrl, session.id, 1);
  expect(readFileSync(join(ctx.sessionsDir, session.id, "reports", listed.filename), "utf8")).toBe("書き手の原稿\n");
  expect(polishedFlag(ctx.sessionsDir, session.id, listed.filename)).toBeUndefined();
});

async function pendingEscalations(baseUrl: string, sessionId: string): Promise<{ filename: string; content: string }[]> {
  return (await fetch(`${baseUrl}/sessions/${sessionId}/asking`).then(r => r.json())).asking;
}

test("a claude session's escalation is shown to the human as the fork's polished text", async () => {
  const gate = gatedPolisher(r => r.kind === "escalation" ? "推敲された問い" : r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  const res = await postJson(baseUrl, `/internal/sessions/${session.id}/escalations`, { slug: "q", content: "問いの原稿" });
  expect(await res.json()).toEqual({ polishing: true });
  expect(await pendingEscalations(baseUrl, session.id)).toEqual([]);
  expect((await loadSessionMeta(session.id, ctx.sessionsDir))!.status).not.toBe("waiting_human");

  await gate.release(0);
  await waitFor(async () => (await pendingEscalations(baseUrl, session.id)).length === 1, "the escalation to be stored");
  expect((await pendingEscalations(baseUrl, session.id))[0].content).toBe("推敲された問い");
  expect(gate.requests[0]).toMatchObject({ kind: "escalation", draft: "問いの原稿", allowReturn: true });
  expect((await loadSessionMeta(session.id, ctx.sessionsDir))!.status).toBe("waiting_human");
  expect(await storedReports(baseUrl, session.id)).toEqual([]);
});

test("a returned escalation is not shown to the human and reaches the writer with its resubmit command", async () => {
  const gate = gatedPolisher(() => ({ returnedReason: "取り消せる操作なので自分で決められる" }));
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/escalations`, { slug: "q", content: "問いの原稿" });
  await gate.release(0);
  await waitFor(async () => (await readEvents(session.id, 1, ctx.sessionsDir)).some(e => e.kind === "report_returned"), "the return");

  expect(await pendingEscalations(baseUrl, session.id)).toEqual([]);
  const fetched = (await fetch(`${baseUrl}/internal/sessions/${session.id}/feedback`).then(r => r.json())).messages;
  expect(fetched).toHaveLength(1);
  expect(fetched[0].content).toContain("取り消せる操作なので自分で決められる");
  expect(fetched[0].content).toContain("問いの原稿");
  expect(fetched[0].content).toContain("worqload escalate submit --slug q");
  expect(fetched[0].content).not.toContain("{{");
});

test("a report and an escalation sharing a slug are each returned at most once on their own", async () => {
  const gate = gatedPolisher(() => ({ returnedReason: "調査がない" }));
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "same", content: "レポート" });
  await gate.release(0);
  await waitFor(async () => (await readEvents(session.id, 1, ctx.sessionsDir)).some(e => e.kind === "report_returned"), "the return");
  await postJson(baseUrl, `/internal/sessions/${session.id}/escalations`, { slug: "same", content: "問い" });
  await waitFor(() => gate.requests.length === 2, "the escalation's polish to start");
  expect(gate.requests[1].allowReturn).toBe(true);
});

test("a session with 推敲モード off shows its escalation as submitted at once", async () => {
  const gate = gatedPolisher(() => "使われないはずの推敲");
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);
  await postJson(baseUrl, `/sessions/${session.id}/report-polish`, { enabled: false });

  const res = await postJson(baseUrl, `/internal/sessions/${session.id}/escalations`, { slug: "q", content: "問いの原稿" });
  expect((await res.json()).filename).toBeDefined();
  expect((await pendingEscalations(baseUrl, session.id)).map(e => e.content)).toEqual(["問いの原稿"]);
  expect(gate.requests).toEqual([]);
});

test("cancelling an escalation by slug while it is polished keeps it from being shown", async () => {
  const gate = gatedPolisher(() => "推敲された問い");
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/escalations`, { slug: "q", content: "問いの原稿" });
  await waitFor(() => gate.requests.length === 1, "the polish to start");
  const cancelled = await postJson(baseUrl, `/internal/sessions/${session.id}/escalations/by-slug/q/cancel`, { reason: "自分で解決した" });
  expect(cancelled.status).toBe(200);
  await gate.release(0);
  await waitFor(() => ctx.reportPolishDrains.size === 0, "the polish to finish");

  expect(await pendingEscalations(baseUrl, session.id)).toEqual([]);
  expect((await loadSessionMeta(session.id, ctx.sessionsDir))!.status).not.toBe("waiting_human");
});

test("cancelling an escalation by slug after it is shown resolves it as cancelled", async () => {
  const gate = gatedPolisher(() => "推敲された問い");
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/escalations`, { slug: "q", content: "問いの原稿" });
  await gate.release(0);
  await waitFor(async () => (await pendingEscalations(baseUrl, session.id)).length === 1, "the escalation to be stored");

  const cancelled = await postJson(baseUrl, `/internal/sessions/${session.id}/escalations/by-slug/q/cancel`, { reason: "自分で解決した" });
  expect(cancelled.status).toBe(200);
  expect(await pendingEscalations(baseUrl, session.id)).toEqual([]);
  const resolved = (await readEvents(session.id, 1, ctx.sessionsDir)).find(e => e.kind === "escalation_resolved")!;
  expect(resolved.payload).toMatchObject({ cancelled: true, reason: "自分で解決した" });
});

test("cancelling a slug with no escalation is a 404", async () => {
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"));
  const session = await createClaudeSession(baseUrl, ctx);
  const res = await postJson(baseUrl, `/internal/sessions/${session.id}/escalations/by-slug/none/cancel`, {});
  expect(res.status).toBe(404);
});

test("each polish is archived with its draft, the fork's rounds and its outcome", async () => {
  const gate = gatedPolisher(r =>
    r.draft === "原稿1" ? { report: "推敲版", rounds: ["1回目", "2回目"] }
    : r.draft.endsWith("原稿2") ? { withdrawnReason: "変化がない" }
    : { returnedReason: "調査がない" });
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir, { reportPolisher: gate.polisher, archiveDbPath: join(repoDir, "archive.db") });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "kept", content: "原稿1" });
  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "noop", content: "原稿2" });
  await postJson(baseUrl, `/internal/sessions/${session.id}/escalations`, { slug: "ask", content: "問い" });
  for (let i = 0; i < 3; i++) await gate.release(i);
  await waitFor(() => listPolishes(ctx.archiveDb!, session.id).length === 3, "three archived polishes");

  const rows = listPolishes(ctx.archiveDb!, session.id);
  expect(rows.map(r => ({ kind: r.kind, slug: r.slug, draft: r.draft, rounds: r.rounds, outcome: r.outcome, result: r.result }))).toEqual([
    { kind: "report", slug: "kept", draft: "原稿1", rounds: ["1回目", "2回目"], outcome: "stored", result: "推敲版" },
    { kind: "report", slug: "noop", draft: "推敲版\n\n原稿2", rounds: [], outcome: "withdrawn", result: "変化がない" },
    { kind: "escalation", slug: "ask", draft: "問い", rounds: [], outcome: "returned", result: "調査がない" },
  ]);
  expect(rows[0].storedFilename).toMatch(/^\d+-kept\.md$/);
  expect(rows[1].storedFilename).toBeNull();
});

test("an escalation cancelled while it is polished is archived as cancelled", async () => {
  const gate = gatedPolisher(() => "推敲された問い");
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir, { reportPolisher: gate.polisher, archiveDbPath: join(repoDir, "archive.db") });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/escalations`, { slug: "q", content: "問いの原稿" });
  await waitFor(() => gate.requests.length === 1, "the polish to start");
  await postJson(baseUrl, `/internal/sessions/${session.id}/escalations/by-slug/q/cancel`, {});
  await gate.release(0);
  await waitFor(() => listPolishes(ctx.archiveDb!, session.id).length === 1, "the archived polish");

  expect(listPolishes(ctx.archiveDb!, session.id)[0]).toMatchObject({ kind: "escalation", outcome: "cancelled", result: "推敲された問い", storedFilename: null });
});

test("a return and a cancellation of a polishing escalation are archived", async () => {
  const gate = gatedPolisher(r => r.kind === "report" ? { returnedReason: "調査がない" } : "推敲された問い");
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir, { reportPolisher: gate.polisher, archiveDbPath: join(repoDir, "archive.db") });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "cause", content: "差し戻される原稿" });
  await gate.release(0);
  await waitFor(() => listAllFeedback(ctx.archiveDb!).some(r => r.sessionId === session.id), "the archived return");
  expect(listAllFeedback(ctx.archiveDb!).find(r => r.sessionId === session.id)!.body).toContain("差し戻される原稿");

  await postJson(baseUrl, `/internal/sessions/${session.id}/escalations`, { slug: "q", content: "問い" });
  await waitFor(() => gate.requests.length === 2, "the escalation's polish to start");
  await postJson(baseUrl, `/internal/sessions/${session.id}/escalations/by-slug/q/cancel`, { reason: "解決した" });
  expect(listCancellations(ctx.archiveDb!, session.id)).toMatchObject([{ kind: "escalation", target: "q", reason: "解決した" }]);
  await gate.release(1);
});

async function requestApproval(baseUrl: string, sessionId: string, command: string, reason: string): Promise<Response> {
  return postJson(baseUrl, `/internal/sessions/${sessionId}/command-approvals`, { command, reason });
}

test("a claude session's command approval is shown with the fork's polished reason and the command as submitted", async () => {
  const gate = gatedPolisher(r => r.kind === "command" ? "推敲された理由" : r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  const res = await requestApproval(baseUrl, session.id, "gh pr create --body-file pr.md", "理由の原稿");
  expect(await res.json()).toEqual({ polishing: true });
  expect(await pendingEscalations(baseUrl, session.id)).toEqual([]);

  await gate.release(0);
  await waitFor(() => ctx.reportPolishDrains.size === 0, "the approval to be stored");
  const [shown] = (await pendingEscalations(baseUrl, session.id)) as { filename: string; content: string; command?: string }[];
  expect(shown.command).toBe("gh pr create --body-file pr.md");
  expect(shown.content).toContain("推敲された理由");
  expect(shown.content).not.toContain("理由の原稿");
  expect(gate.requests[0]).toMatchObject({ kind: "command", draft: "理由の原稿", command: "gh pr create --body-file pr.md", allowReturn: true });
  expect((await loadSessionMeta(session.id, ctx.sessionsDir))!.status).toBe("waiting_human");

  const sidecar = JSON.parse(readFileSync(join(ctx.sessionsDir, session.id, "asking", shown.filename.replace(/\.md$/, ".command.json")), "utf8"));
  expect(sidecar).toMatchObject({ command: "gh pr create --body-file pr.md", reason: "推敲された理由" });
});

test("a returned command approval reaches the writer with its resubmit command, and the same command is not returned again", async () => {
  const gate = gatedPolisher(() => ({ returnedReason: "本文に留保がある" }));
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await requestApproval(baseUrl, session.id, "gh issue comment 1 --body-file c.md", "理由の原稿");
  await gate.release(0);
  await waitFor(async () => (await readEvents(session.id, 1, ctx.sessionsDir)).some(e => e.kind === "report_returned"), "the return");

  expect(await pendingEscalations(baseUrl, session.id)).toEqual([]);
  const fetched = (await fetch(`${baseUrl}/internal/sessions/${session.id}/feedback`).then(r => r.json())).messages;
  expect(fetched).toHaveLength(1);
  expect(fetched[0].content).toContain("本文に留保がある");
  expect(fetched[0].content).toContain("理由の原稿");
  expect(fetched[0].content).toContain("worqload escalate command --command");
  expect(fetched[0].content).not.toContain("{{");

  await requestApproval(baseUrl, session.id, "gh issue comment 1 --body-file c.md", "直した理由");
  await requestApproval(baseUrl, session.id, "gh issue comment 2 --body-file c.md", "別のコマンド");
  await waitFor(() => gate.requests.length === 2, "the resubmission's polish to start");
  expect(gate.requests[1].allowReturn).toBe(false);
  await gate.release(1);
  await waitFor(() => gate.requests.length === 3, "the other command's polish to start");
  expect(gate.requests[2].allowReturn).toBe(true);
  await gate.release(2);
  await waitFor(() => ctx.reportPolishDrains.size === 0, "the polishes to finish");
});

test("a command approval waiting for its polish absorbs a duplicate request for the same command", async () => {
  const gate = gatedPolisher(r => r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await requestApproval(baseUrl, session.id, "npm publish", "一回目");
  const second = await requestApproval(baseUrl, session.id, "npm publish", "二回目");
  expect(await second.json()).toEqual({ polishing: true });
  await gate.release(0);
  await waitFor(() => ctx.reportPolishDrains.size === 0, "the polish to finish");

  expect(gate.requests).toHaveLength(1);
  expect(await pendingEscalations(baseUrl, session.id)).toHaveLength(1);
});

test("cancelling a command approval by its command while it is polished keeps it from being shown", async () => {
  const gate = gatedPolisher(r => r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await requestApproval(baseUrl, session.id, "npm publish", "公開する");
  await waitFor(() => gate.requests.length === 1, "the polish to start");
  const cancelled = await postJson(baseUrl, `/internal/sessions/${session.id}/command-approvals/cancel`, { command: "npm publish", reason: "不要になった" });
  expect(cancelled.status).toBe(200);
  await gate.release(0);
  await waitFor(() => ctx.reportPolishDrains.size === 0, "the polish to finish");

  expect(await pendingEscalations(baseUrl, session.id)).toEqual([]);
  expect((await loadSessionMeta(session.id, ctx.sessionsDir))!.status).not.toBe("waiting_human");
});

test("cancelling a command approval by its command after it is shown resolves it as cancelled", async () => {
  const gate = gatedPolisher(r => r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await requestApproval(baseUrl, session.id, "npm publish", "公開する");
  await gate.release(0);
  await waitFor(() => ctx.reportPolishDrains.size === 0, "the approval to be stored");

  const cancelled = await postJson(baseUrl, `/internal/sessions/${session.id}/command-approvals/cancel`, { command: "npm publish" });
  expect(cancelled.status).toBe(200);
  expect(await pendingEscalations(baseUrl, session.id)).toEqual([]);
  expect((await readEvents(session.id, 1, ctx.sessionsDir)).find(e => e.kind === "escalation_resolved")!.payload).toMatchObject({ cancelled: true });
});

test("cancelling a command with no approval is a 404", async () => {
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"));
  const session = await createClaudeSession(baseUrl, ctx);
  const res = await postJson(baseUrl, `/internal/sessions/${session.id}/command-approvals/cancel`, { command: "npm publish" });
  expect(res.status).toBe(404);
});

test("a session with 推敲モード off shows its command approval as submitted at once", async () => {
  const gate = gatedPolisher(() => "使われないはずの推敲");
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);
  await postJson(baseUrl, `/sessions/${session.id}/report-polish`, { enabled: false });

  const res = await requestApproval(baseUrl, session.id, "npm publish", "公開する");
  expect((await res.json()).filename).toBeDefined();
  expect((await pendingEscalations(baseUrl, session.id))[0].content).toContain("公開する");
  expect(gate.requests).toEqual([]);
});

test("a report after which the fork judges the writer should not stop is shown and wakes the writer with the reason", async () => {
  const gate = gatedPolisher(() => ({ report: "推敲された本文", continueReason: "人間の質問に答えていない" }));
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "status", content: "書き手の原稿" });
  await gate.release(0);
  const [stored] = await waitForReports(baseUrl, session.id, 1);
  expect(stored.content).toBe("推敲された本文");
  await waitFor(() => ctx.reportPolishDrains.size === 0, "the polish to finish");

  const fetched = (await fetch(`${baseUrl}/internal/sessions/${session.id}/feedback`).then(r => r.json())).messages;
  expect(fetched).toHaveLength(1);
  expect(fetched[0].content).toContain("人間の質問に答えていない");
  expect(fetched[0].content).not.toContain("{{");
});

test("a report the writer followed with another submission does not wake the writer, since the fork could not see it", async () => {
  const gate = gatedPolisher(r => r.draft === "最初の原稿" ? { report: "推敲された本文", continueReason: "完了を報告していない" } : r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "first", content: "最初の原稿" });
  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "done", content: "完了の報告" });
  await gate.release(0);
  await gate.release(1);
  await waitFor(() => ctx.reportPolishDrains.size === 0, "the polishes to finish");

  const fetched = (await fetch(`${baseUrl}/internal/sessions/${session.id}/feedback`).then(r => r.json())).messages;
  expect(fetched).toEqual([]);
});

// A judge that objects to every draft and records what it was shown.
function objectingJudge(objection: string) {
  const requests: ReportJudgeRequest[] = [];
  const judge: ReportJudge = async (request) => {
    requests.push(request);
    return objection;
  };
  return { judge, requests };
}

test("a report's draft is judged from what the human has seen, and the objection reaches the fork and the archive", async () => {
  const gate = gatedPolisher(r => r.draft);
  const reader = objectingJudge("冒頭が作業の記録になっている");
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir, { reportPolisher: gate.polisher, reportJudge: reader.judge, archiveDbPath: join(repoDir, "archive.db") });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "first", content: "見せたレポート" });
  await gate.release(0);
  await waitForReports(baseUrl, session.id, 1);
  await postJson(baseUrl, `/sessions/${session.id}/feedback`, { content: "人間の質問" });
  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "second", content: "判定する原稿" });
  await gate.release(1);
  await waitForReports(baseUrl, session.id, 2);

  expect(reader.requests[1]).toMatchObject({
    task: "x",
    draft: "判定する原稿",
    timeline: [{ kind: "report", text: "見せたレポート" }, { kind: "human", text: "人間の質問" }],
  });
  expect(gate.requests[1].readerObjection).toBe("冒頭が作業の記録になっている");
  await waitFor(() => listPolishes(ctx.archiveDb!, session.id).length === 2, "two archived polishes");
  expect(listPolishes(ctx.archiveDb!, session.id)[1].readerObjection).toBe("冒頭が作業の記録になっている");
});

test("an escalation is not judged by the human-side reader", async () => {
  const gate = gatedPolisher(r => r.draft);
  const reader = objectingJudge("不要");
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher, reportJudge: reader.judge });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/escalations`, { slug: "q", content: "問い" });
  await gate.release(0);

  expect(reader.requests).toEqual([]);
  expect(gate.requests[0].readerObjection).toBeUndefined();
});

async function postReport(baseUrl: string, sessionId: string, slug: string, content: string) {
  await postJson(baseUrl, `/internal/sessions/${sessionId}/reports`, { slug, content });
}

function reportMeta(sessionsDir: string, sessionId: string, filename: string): Record<string, unknown> {
  const metaPath = join(sessionsDir, sessionId, "reports", filename.replace(/\.md$/, ".meta.json"));
  return existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
}

test("a draft submitted while the session's earlier reports are unread is polished together with them and shown in their place", async () => {
  const gate = gatedPolisher(r => r.mergedReportCount ? "まとめた本文" : r.draft);
  const reader = objectingJudge("不要");
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir, { reportPolisher: gate.polisher, reportJudge: reader.judge, archiveDbPath: join(repoDir, "archive.db") });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/sessions/${session.id}/report-polish`, { enabled: false });
  await postReport(baseUrl, session.id, "first", "一本目");
  await postReport(baseUrl, session.id, "second", "二本目");
  await postJson(baseUrl, `/sessions/${session.id}/report-polish`, { enabled: true });
  await postReport(baseUrl, session.id, "third", "三本目");
  await gate.release(0);
  await waitFor(async () => (await storedReports(baseUrl, session.id)).some(r => r.content === "まとめた本文"), "the merged report");

  expect(gate.requests[0]).toMatchObject({ draft: "一本目\n\n二本目\n\n三本目", mergedReportCount: 2 });
  expect(reader.requests[0]).toMatchObject({ draft: "一本目\n\n二本目\n\n三本目", timeline: [] });
  const shown = await storedReports(baseUrl, session.id);
  expect(shown.map(r => r.content)).toEqual(["まとめた本文"]);
  const sessions = (await fetch(`${baseUrl}/sessions`).then(r => r.json())).sessions;
  expect(sessions.find((s: { id: string }) => s.id === session.id).unreadReportCount).toBe(1);
  const hidden = readdirSync(join(ctx.sessionsDir, session.id, "reports")).filter(n => n.endsWith(".md") && n !== shown[0].filename);
  expect(hidden).toHaveLength(2);
  for (const name of hidden) expect(reportMeta(ctx.sessionsDir, session.id, name).supersededBy).toBe(shown[0].filename);
  await waitFor(() => listPolishes(ctx.archiveDb!, session.id).length === 1, "the archived polish");
  expect(listPolishes(ctx.archiveDb!, session.id)[0]).toMatchObject({ draft: "一本目\n\n二本目\n\n三本目", storedFilename: shown[0].filename, mergedReports: hidden.sort() });
});

test("a report the human has read is not merged into the next draft", async () => {
  const gate = gatedPolisher(r => r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postReport(baseUrl, session.id, "first", "読んだレポート");
  await gate.release(0);
  const [first] = await waitForReports(baseUrl, session.id, 1);
  await postJson(baseUrl, `/sessions/${session.id}/reports/${first.filename}/read`, {});
  await postReport(baseUrl, session.id, "second", "次の原稿");
  await gate.release(1);
  await waitForReports(baseUrl, session.id, 2);

  expect(gate.requests[1].draft).toBe("次の原稿");
  expect(gate.requests[1].mergedReportCount).toBeUndefined();
});

test("an unread report with images is not merged, since the merged report would lose them", async () => {
  const gate = gatedPolisher(r => r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  const form = new FormData();
  form.set("payload", JSON.stringify({ slug: "shot", content: "画像付き" }));
  form.append("attachment", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" }));
  await fetch(`${baseUrl}/internal/sessions/${session.id}/reports`, { method: "POST", body: form });
  await gate.release(0);
  await waitForReports(baseUrl, session.id, 1);
  await postReport(baseUrl, session.id, "second", "次の原稿");
  await gate.release(1);
  await waitForReports(baseUrl, session.id, 2);

  expect(gate.requests[1].draft).toBe("次の原稿");
});

test("a withdrawn merged draft leaves the unread reports it would have replaced in place", async () => {
  const gate = gatedPolisher(r => r.mergedReportCount ? { withdrawnReason: "不要" } : r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postReport(baseUrl, session.id, "first", "一本目");
  await gate.release(0);
  await waitForReports(baseUrl, session.id, 1);
  await postReport(baseUrl, session.id, "second", "二本目");
  await gate.release(1);
  await waitFor(async () => (await readEvents(session.id, 1, ctx.sessionsDir)).some(e => e.kind === "report_withdrawn"), "the withdrawal");

  expect((await storedReports(baseUrl, session.id)).map(r => r.content)).toEqual(["一本目"]);
});

test("a draft whose merged report was rejected during the polish is shown alone as the writer submitted it", async () => {
  const gate = gatedPolisher(r => r.mergedReportCount ? "まとめた本文" : r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postReport(baseUrl, session.id, "first", "一本目");
  await gate.release(0);
  const [first] = await waitForReports(baseUrl, session.id, 1);
  await postReport(baseUrl, session.id, "second", "二本目");
  await waitFor(() => gate.requests.length === 2, "the merged polish to start");
  expect(gate.requests[1].mergedReportCount).toBe(1);
  await postJson(baseUrl, `/sessions/${session.id}/reports/${first.filename}/reject`, { reason: "いらない" });
  await gate.release(1);
  await waitFor(() => ctx.reportPolishDrains.size === 0, "the polish to finish");

  expect((await storedReports(baseUrl, session.id)).map(r => r.content)).toEqual(["二本目"]);
  expect(reportMeta(ctx.sessionsDir, session.id, first.filename).supersededBy).toBeUndefined();
});

test("a report shown before the human's latest message is not merged, since the human answered after seeing it", async () => {
  const gate = gatedPolisher(r => r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postReport(baseUrl, session.id, "first", "人間が答えたレポート");
  await gate.release(0);
  await waitForReports(baseUrl, session.id, 1);
  await postJson(baseUrl, `/sessions/${session.id}/feedback`, { content: "人間の質問" });
  await postReport(baseUrl, session.id, "answer", "質問への回答");
  await gate.release(1);
  await waitForReports(baseUrl, session.id, 2);

  expect(gate.requests[1].draft).toBe("質問への回答");
});
