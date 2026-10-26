import { afterEach, expect, test } from "bun:test";
import { join } from "path";
import type { ReportPolisher, ReportPolishRequest } from "./report-polish";
import { loadSessionMeta, saveSessionMeta } from "./session";
import { cleanupAll, fakeWorktreeOps, inProcessHostLauncher, makeTmpDir, trackCleanup } from "./test-helpers";
import { startServer } from "./web-server";

afterEach(cleanupAll);

const TEST_BASE = "trunk";
const CLAUDE_CONVERSATION_ID = "5d0c8a7e-2b1f-4e3d-9c8b-7a6f5e4d3c2b";

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
function gatedPolisher(polish: (request: ReportPolishRequest) => string) {
  const requests: ReportPolishRequest[] = [];
  const releases: (() => void)[] = [];
  const polisher: ReportPolisher = async (request) => {
    requests.push(request);
    await new Promise<void>(resolve => releases.push(resolve));
    return polish(request);
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

test("the polished version reaches the writer's inbox and stays out of the human's feedback list", async () => {
  const gate = gatedPolisher(() => "推敲された本文");
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "書き手の原稿" });
  await gate.release(0);
  await waitFor(async () => ctx.reportPolishDrains.size === 0 && (await storedReports(baseUrl, session.id)).length === 1, "the polish to finish");

  const humanList = (await fetch(`${baseUrl}/sessions/${session.id}/feedback`).then(r => r.json())).messages;
  expect(humanList).toEqual([]);
  const fetched = (await fetch(`${baseUrl}/internal/sessions/${session.id}/feedback`).then(r => r.json())).messages;
  expect(fetched).toHaveLength(1);
  expect(fetched[0].content).toContain("推敲された本文");
});

test("a polish that leaves the draft unchanged sends nothing to the writer's inbox", async () => {
  const gate = gatedPolisher(r => r.draft);
  const { baseUrl, ctx } = await bootServer(makeTmpDir("repo"), { reportPolisher: gate.polisher });
  const session = await createClaudeSession(baseUrl, ctx);

  await postJson(baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "書き手の原稿" });
  await gate.release(0);
  await waitFor(async () => ctx.reportPolishDrains.size === 0 && (await storedReports(baseUrl, session.id)).length === 1, "the polish to finish");
  const fetched = (await fetch(`${baseUrl}/internal/sessions/${session.id}/feedback`).then(r => r.json())).messages;
  expect(fetched).toEqual([]);
});

test("a session's polishes run one at a time and the next fork learns the versions the writer has not fetched", async () => {
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
  const reports = await waitForReports(baseUrl, session.id, 2);
  expect(reports.map(r => r.content).sort()).toEqual(["推敲版: 原稿1", "推敲版: 原稿2"]);
  expect(gate.requests[0].unreadPolished).toEqual([]);
  expect(gate.requests[1].unreadPolished).toEqual(["推敲版: 原稿1"]);
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

test("a draft accepted before a server restart is polished and stored by the next server", async () => {
  const repoDir = makeTmpDir("repo");
  const never: ReportPolisher = () => new Promise(() => {});
  const first = await bootServer(repoDir, { reportPolisher: never });
  const session = await createClaudeSession(first.baseUrl, first.ctx);
  await postJson(first.baseUrl, `/internal/sessions/${session.id}/reports`, { slug: "plan", content: "再起動をまたぐ原稿" });
  await first.shutdown({ killHosts: true });

  const second = await bootServer(repoDir, { reportPolisher: async r => `推敲版: ${r.draft}` });
  const [stored] = await waitForReports(second.baseUrl, session.id, 1);
  expect(stored.content).toBe("推敲版: 再起動をまたぐ原稿");
});
