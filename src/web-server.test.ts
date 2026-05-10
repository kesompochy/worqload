import { test, expect, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "fs";
import { startServer } from "./web-server";
import { loadSessionMeta } from "./session";
import { readEvents } from "./event-log";
import { makeTmpDir, cleanupAll, trackCleanup } from "./test-helpers";

afterEach(cleanupAll);

const cleanGitEnv = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };
const TEST_BASE = "trunk";
const MOCK = join(import.meta.dir, "__fixtures__", "mock-claude.ts");

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: cleanGitEnv });
}

function makeRepo(): string {
  const dir = makeTmpDir("web-server-test");
  git(["init"], dir);
  git(["checkout", "-b", TEST_BASE], dir);
  git(["config", "user.email", "t@t.com"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "README.md"), "# t\n");
  writeFileSync(join(dir, ".gitignore"), ".worqload/\n.worqload-reports\n.worktrees/\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

async function bootServer(repoDir: string, mockMode: "init" | "echo" | "hang" = "hang") {
  const started = await startServer({
    port: 0,
    repoDir,
    spawnCommand: ["bun", MOCK, mockMode],
  });
  trackCleanup(() => started.shutdown());
  return { ...started, baseUrl: `http://127.0.0.1:${started.server.port}` };
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /sessions creates a session, worktree, meta.json", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const res = await postJson(baseUrl, "/sessions", {
    prompt: "do thing",
    baseBranch: TEST_BASE,
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.meta.id).toBeDefined();
  expect(body.meta.status).toBe("running");
  expect(body.meta.baseBranch).toBe(TEST_BASE);
  expect(body.meta.worktreePath).toContain(".worktrees");

  const meta = await loadSessionMeta(body.meta.id, ctx.sessionsDir);
  expect(meta).not.toBeNull();
  expect(existsSync(body.meta.worktreePath)).toBe(true);
  expect(existsSync(join(body.meta.worktreePath, ".worqload-reports"))).toBe(true);
});

test("GET /sessions lists created sessions", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  await postJson(baseUrl, "/sessions", { prompt: "first", baseBranch: TEST_BASE });
  await postJson(baseUrl, "/sessions", { prompt: "second", baseBranch: TEST_BASE });

  const res = await fetch(`${baseUrl}/sessions`);
  const body = await res.json();
  expect(body.sessions).toHaveLength(2);
});

test("POST /internal/sessions/:id/reports writes numbered report", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  const r1 = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "this is the plan" }).then(r => r.json());
  expect(r1.filename).toBe("001-plan.md");
  expect(r1.seq).toBe(1);

  const r2 = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "build-failed", content: "stuff broke" }).then(r => r.json());
  expect(r2.filename).toBe("002-build-failed.md");

  const reportsDir = join(ctx.sessionsDir, sid, "reports");
  expect(readdirSync(reportsDir).sort()).toEqual(["001-plan.md", "002-build-failed.md"]);
  const events = await readEvents(sid, 1, ctx.sessionsDir);
  const reportEvents = events.filter(e => e.kind === "report_submitted");
  expect(reportEvents).toHaveLength(2);
});

test("POST /internal/sessions/:id/escalations sets status to waiting_human", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  const e = await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, { slug: "which-lib", content: "X or Y?" }).then(r => r.json());
  expect(e.filename).toBe("001-which-lib.md");

  const meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("waiting_human");
  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.some(ev => ev.kind === "escalation_requested")).toBe(true);
});

test("feedback inbox round trip: POST writes, GET fetches and moves to read", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "hi there", slug: "say-hi" });
  await postJson(baseUrl, `/sessions/${sid}/feedback`, {
    content: "fix this please",
    slug: "fix-this",
    anchor: { path: "src/foo.ts", lineStart: 40, lineEnd: 45 },
  });

  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  expect(readdirSync(inboxDir).sort()).toEqual(["001-say-hi.md", "002-fix-this.md"]);

  const fetched = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then(r => r.json());
  expect(fetched.messages).toHaveLength(2);
  expect(fetched.messages[1].content).toContain("Re: src/foo.ts:40-45");

  // After fetch, inbox should be empty and read/ should contain them
  expect(readdirSync(inboxDir)).toEqual([]);
  const readDir = join(ctx.sessionsDir, sid, "feedback", "read");
  expect(readdirSync(readDir).sort()).toEqual(["001-say-hi.md", "002-fix-this.md"]);
});

test("POST /sessions/:id/stop kills runner and sets status stopped", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  // give the runner a moment to be alive
  await new Promise(r => setTimeout(r, 100));

  const stopped = await postJson(baseUrl, `/sessions/${sid}/stop`, {}).then(r => r.json());
  expect(stopped.meta.status).toBe("stopped");
  expect(stopped.meta.endedAt).toBeDefined();

  const meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("stopped");
  expect(ctx.runners.has(sid)).toBe(false);
});

test("escalation resolve moves asking file, writes feedback, returns to running", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, { slug: "lib", content: "X or Y?" });

  // before resolve
  let detail = await fetch(`${baseUrl}/sessions/${sid}`).then(r => r.json());
  expect(detail.meta.status).toBe("waiting_human");

  const resolved = await postJson(baseUrl, `/sessions/${sid}/escalations/001-lib.md/resolve`, {
    content: "go with X",
  }).then(r => r.json());
  expect(resolved.ok).toBe(true);

  // status returned to running
  detail = await fetch(`${baseUrl}/sessions/${sid}`).then(r => r.json());
  expect(detail.meta.status).toBe("running");

  // asking dir empty top-level, resolved/ has the file
  const askingTop = readdirSync(join(ctx.sessionsDir, sid, "asking"));
  expect(askingTop).toContain("resolved");
  expect(askingTop.filter(f => f.endsWith(".md"))).toEqual([]);
  expect(readdirSync(join(ctx.sessionsDir, sid, "asking", "resolved"))).toEqual(["001-lib.md"]);

  // feedback inbox has the answer
  const inboxRes = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then(r => r.json());
  expect(inboxRes.messages).toHaveLength(1);
  expect(inboxRes.messages[0].content).toContain("X or Y?");
  expect(inboxRes.messages[0].content).toContain("go with X");
});

test("escalation resolve returns 404 for missing file", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  const res = await fetch(`${baseUrl}/sessions/${sid}/escalations/nope.md/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "answer" }),
  });
  expect(res.status).toBe(404);
});

test("escalation resolve keeps waiting_human when other escalations remain", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, { slug: "first", content: "A?" });
  await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, { slug: "second", content: "B?" });

  await postJson(baseUrl, `/sessions/${sid}/escalations/001-first.md/resolve`, { content: "answer A" });

  const detail = await fetch(`${baseUrl}/sessions/${sid}`).then(r => r.json());
  expect(detail.meta.status).toBe("waiting_human");
});

test("GET /sessions/:id/reports returns all reports with content", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "the plan" });
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "build", content: "build result" });

  const res = await fetch(`${baseUrl}/sessions/${sid}/reports`).then(r => r.json());
  expect(res.reports).toHaveLength(2);
  expect(res.reports[0].filename).toBe("001-plan.md");
  expect(res.reports[0].content).toBe("the plan");
  expect(res.reports[1].filename).toBe("002-build.md");
});

test("GET /sessions/:id/diff returns git diff against session-start commit", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  const wt = created.meta.worktreePath;
  // Modify the README in the worktree to produce a diff.
  writeFileSync(join(wt, "README.md"), "# changed in session\n");

  const diffRes = await fetch(`${baseUrl}/sessions/${sid}/diff`);
  expect(diffRes.headers.get("content-type")).toContain("text/plain");
  const diff = await diffRes.text();
  expect(diff).toContain("README.md");
  expect(diff).toContain("changed in session");
});

test("GET /sessions/:id/asking returns pending escalations", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, { slug: "lib", content: "X or Y?" });

  const res = await fetch(`${baseUrl}/sessions/${sid}/asking`).then(r => r.json());
  expect(res.asking).toHaveLength(1);
  expect(res.asking[0].content).toBe("X or Y?");
});

test("POST /sessions/:id/archive hides terminal sessions from default list", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;
  await new Promise(r => setTimeout(r, 80));

  // Cannot archive while running
  const tooEarly = await fetch(`${baseUrl}/sessions/${sid}/archive`, { method: "POST" });
  expect(tooEarly.status).toBe(400);

  await postJson(baseUrl, `/sessions/${sid}/cancel`, {});
  const archived = await postJson(baseUrl, `/sessions/${sid}/archive`, {}).then(r => r.json());
  expect(archived.meta.archivedAt).toBeDefined();

  const visible = await fetch(`${baseUrl}/sessions`).then(r => r.json());
  expect(visible.sessions.find((s: { id: string }) => s.id === sid)).toBeUndefined();

  const all = await fetch(`${baseUrl}/sessions?includeArchived=true`).then(r => r.json());
  expect(all.sessions.find((s: { id: string }) => s.id === sid)).toBeDefined();
});

test("GET /sessions/:id/feedback merges inbox and read with status", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "first", slug: "a" });
  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "second", slug: "b" });
  // drain only the first one by simulating an agent fetch
  await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then(r => r.json());
  // post a third one after fetch
  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "third", slug: "c" });

  const history = await fetch(`${baseUrl}/sessions/${sid}/feedback`).then(r => r.json());
  expect(history.messages).toHaveLength(3);
  // first two were drained (status read), third is unread
  const byContent = Object.fromEntries(history.messages.map((m: { content: string; status: string }) => [m.content, m.status]));
  expect(byContent["first"]).toBe("read");
  expect(byContent["second"]).toBe("read");
  expect(byContent["third"]).toBe("unread");
});

test("startServer reconciles orphan sessions on boot to crashed", async () => {
  const repoDir = makeRepo();
  // First server: create a session
  const first = await startServer({ port: 0, repoDir, spawnCommand: ["bun", MOCK, "hang"] });
  trackCleanup(() => first.shutdown());
  const baseUrl1 = `http://127.0.0.1:${first.server.port}`;
  const created = await postJson(baseUrl1, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  // Stop the first server WITHOUT marking sessions stopped — emulate a crash.
  // (shutdown() kills runners but also stops the server; sessions remain
  // running on disk because the exit handler is racing the dir cleanup.
  // We force the meta to running just in case.)
  first.server.stop(true);
  for (const r of first.ctx.runners.values()) {
    try { r.kill("SIGKILL"); } catch {}
    await r.exited.catch(() => {});
  }
  // Manually restore status=running so the next startServer sees it as orphan
  const { saveSessionMeta, loadSessionMeta } = await import("./session");
  const meta = await loadSessionMeta(sid, first.ctx.sessionsDir);
  if (meta) {
    await saveSessionMeta({ ...meta, status: "running", endedAt: undefined }, first.ctx.sessionsDir);
  }

  // Second server: should reconcile the orphan
  const second = await startServer({ port: 0, repoDir, spawnCommand: ["bun", MOCK, "hang"] });
  trackCleanup(() => second.shutdown());
  const baseUrl2 = `http://127.0.0.1:${second.server.port}`;

  const detail = await fetch(`${baseUrl2}/sessions/${sid}`).then(r => r.json());
  expect(detail.meta.status).toBe("crashed");
  expect(detail.meta.endedAt).toBeDefined();
  expect(detail.events.some((e: { kind: string }) => e.kind === "session_crashed")).toBe(true);
});

test("WS /sessions/:id/stream replays past events on subscribe and pushes live ones", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  // Wait briefly so session_started has been written
  await new Promise(r => setTimeout(r, 80));

  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/sessions/${sid}/stream`);
  await new Promise<void>(resolve => ws.addEventListener("open", () => resolve(), { once: true }));

  const messages: { sessionId: string; event: { kind: string; seq: number } }[] = [];
  ws.addEventListener("message", e => {
    messages.push(JSON.parse(typeof e.data === "string" ? e.data : ""));
  });

  ws.send(JSON.stringify({ type: "subscribe", lastSeq: 0 }));
  // wait for replay
  await new Promise(r => setTimeout(r, 100));
  expect(messages.some(m => m.event.kind === "session_started")).toBe(true);

  // Now trigger a new server-side event and confirm it streams to the client.
  const messageCountBefore = messages.length;
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "live", content: "live event body" });
  await new Promise(r => setTimeout(r, 100));

  expect(messages.length).toBeGreaterThan(messageCountBefore);
  expect(messages.some(m => m.event.kind === "report_submitted")).toBe(true);

  ws.close();
  await new Promise(r => setTimeout(r, 30));
});

test("POST /sessions/:id/cancel removes worktree and marks stopped", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;
  await new Promise(r => setTimeout(r, 100));

  const wt = created.meta.worktreePath;
  expect(existsSync(wt)).toBe(true);

  await postJson(baseUrl, `/sessions/${sid}/cancel`, {});

  expect(existsSync(wt)).toBe(false);
  const meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("stopped");
});

test("GET /actions exposes the built-in action registry", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const res = await fetch(`${baseUrl}/actions`).then(r => r.json());
  const ids = res.actions.map((a: { id: string }) => a.id);
  expect(ids).toContain("merge-to-base");
  expect(ids).toContain("create-pr");
});

test("POST /sessions/:id/actions/:actionId returns 404 for unknown action", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");
  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  const res = await postJson(baseUrl, `/sessions/${sid}/actions/nope`, {});
  expect(res.status).toBe(404);
});

test("POST /sessions/:id/actions/merge-to-base merges when preconditions hold", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");
  const created = await postJson(baseUrl, "/sessions", { prompt: "merge me", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;
  const wt = created.meta.worktreePath;

  // commit a change in the worktree so there is something to merge
  writeFileSync(join(wt, "feature.txt"), "hello\n");
  Bun.spawnSync(["git", "add", "feature.txt"], { cwd: wt, env: cleanGitEnv });
  Bun.spawnSync(["git", "commit", "-m", "feature"], { cwd: wt, env: cleanGitEnv });

  const res = await postJson(baseUrl, `/sessions/${sid}/actions/merge-to-base`, {});
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.actionId).toBe("merge-to-base");

  // base branch should now have the merged file
  const show = Bun.spawnSync(["git", "show", `${TEST_BASE}:feature.txt`], { cwd: repoDir, env: cleanGitEnv });
  expect(show.exitCode).toBe(0);
});

test("POST /sessions/:id/actions/merge-to-base returns 422 when preconditions fail", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");
  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  // dirty the main repo
  writeFileSync(join(repoDir, "scratch.txt"), "dirt\n");
  Bun.spawnSync(["git", "add", "scratch.txt"], { cwd: repoDir, env: cleanGitEnv });

  const res = await postJson(baseUrl, `/sessions/${sid}/actions/merge-to-base`, {});
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.message).toBeDefined();
});
