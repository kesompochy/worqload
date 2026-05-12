import { test, expect, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "fs";
import { startServer } from "./web-server";
import { agentEndpointPath, loadSessionMeta } from "./session";
import { readEvents } from "./event-log";
import { makeTmpDir, cleanupAll, trackCleanup } from "./test-helpers";

afterEach(cleanupAll);

const cleanGitEnv = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };
const TEST_BASE = "trunk";
const MOCK = join(import.meta.dir, "__fixtures__", "mock-claude.ts");
const CLI = join(import.meta.dir, "cli.ts");
// Run the host as a child of the test process so we exercise the real
// detached-spawn path. `bun <cli> session-host` is the same binding
// `worqload session-host` would invoke after `bun link`.
const HOST_COMMAND = ["bun", CLI, "session-host"];

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
    // Skip real claude branch-name generation so the test doesn't depend on
    // `claude` being on PATH; resolveBranchName falls back to <shortId>.
    branchNameGenerator: async () => null,
    hostCommand: HOST_COMMAND,
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

test("startServer auto-shifts to a free port when the requested port is in use", async () => {
  const repoDir1 = makeRepo();
  const repoDir2 = makeRepo();

  const first = await startServer({
    port: 0,
    repoDir: repoDir1,
    spawnCommand: ["bun", MOCK, "hang"],
    branchNameGenerator: async () => null,
    hostCommand: HOST_COMMAND,
  });
  trackCleanup(() => first.shutdown({ killHosts: true }));

  const requestedPort = first.ctx.port;

  const second = await startServer({
    port: requestedPort,
    repoDir: repoDir2,
    spawnCommand: ["bun", MOCK, "hang"],
    branchNameGenerator: async () => null,
    hostCommand: HOST_COMMAND,
  });
  trackCleanup(() => second.shutdown({ killHosts: true }));

  expect(second.ctx.port).not.toBe(requestedPort);
  expect(second.ctx.port).toBeGreaterThan(requestedPort);
  expect(second.ctx.baseUrlForAgent).toBe(`http://127.0.0.1:${second.ctx.port}`);
});

test("GET /meta returns the repo directory and its basename", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const res = await fetch(`${baseUrl}/meta`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.repoDir).toBe(repoDir);
  expect(body.repoName).toBe(repoDir.split("/").pop());
});

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
  // generator is stubbed to return null in tests, so the branch falls back
  // to the 8-char short id (no "worqload/" prefix).
  expect(body.meta.branchName).toBe(body.meta.id.slice(0, 8));
  expect(body.meta.branchName).not.toContain("worqload");

  const meta = await loadSessionMeta(body.meta.id, ctx.sessionsDir);
  expect(meta).not.toBeNull();
  expect(existsSync(body.meta.worktreePath)).toBe(true);
  expect(existsSync(join(body.meta.worktreePath, ".worqload-reports"))).toBe(true);
});

test("POST /sessions accepts an explicit branchName", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const res = await postJson(baseUrl, "/sessions", {
    prompt: "do thing",
    baseBranch: TEST_BASE,
    branchName: "fix-login-bug",
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.meta.branchName).toBe("fix-login-bug");

  // git knows about the branch under the requested name
  const list = Bun.spawnSync(["git", "branch", "--list", "fix-login-bug"], {
    cwd: repoDir,
    env: cleanGitEnv,
  });
  expect(new TextDecoder().decode(list.stdout).trim()).toContain("fix-login-bug");
});

test("POST /sessions uses generated branch name when no explicit one is given", async () => {
  const repoDir = makeRepo();
  const started = await startServer({
    port: 0,
    repoDir,
    spawnCommand: ["bun", MOCK, "hang"],
    branchNameGenerator: async () => "auto-name",
    hostCommand: HOST_COMMAND,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;

  const res = await postJson(baseUrl, "/sessions", {
    prompt: "do thing",
    baseBranch: TEST_BASE,
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.meta.branchName).toBe("auto-name");
});

test("POST /sessions returns 400 when branchName is invalid", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const res = await postJson(baseUrl, "/sessions", {
    prompt: "do thing",
    baseBranch: TEST_BASE,
    branchName: "-leading-dash",
  });
  expect(res.status).toBe(400);
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

test("GET /sessions exposes unread report counts per session", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const a = await postJson(baseUrl, "/sessions", { prompt: "with reports", baseBranch: TEST_BASE }).then(r => r.json());
  const b = await postJson(baseUrl, "/sessions", { prompt: "no reports", baseBranch: TEST_BASE }).then(r => r.json());
  const aid = a.meta.id;
  const bid = b.meta.id;

  await postJson(baseUrl, `/internal/sessions/${aid}/reports`, { slug: "plan", content: "the plan" });
  await postJson(baseUrl, `/internal/sessions/${aid}/reports`, { slug: "step", content: "step done" });
  await postJson(baseUrl, `/internal/sessions/${aid}/reports`, { slug: "more", content: "more progress" });
  await postJson(baseUrl, `/sessions/${aid}/reports/001-plan.md/read`, {});

  const body = await fetch(`${baseUrl}/sessions`).then(r => r.json());
  const byId = Object.fromEntries(body.sessions.map((s: { id: string; unreadReportCount: number }) => [s.id, s]));
  expect(byId[aid].unreadReportCount).toBe(2);
  expect(byId[bid].unreadReportCount).toBe(0);
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

test("feedback numbering stays monotonic after a fetch drains the inbox", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "first", slug: "a" });
  await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then(r => r.json());
  const second = await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "second", slug: "b" }).then(r => r.json());

  expect(second.filename).toBe("002-b.md");
  expect(second.seq).toBe(2);

  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  expect(readdirSync(inboxDir)).toEqual(["002-b.md"]);
});

test("POST /sessions/:id/stop kills the host and sets status stopped", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  // give the host a moment to be alive
  await new Promise(r => setTimeout(r, 100));

  const stopped = await postJson(baseUrl, `/sessions/${sid}/stop`, {}).then(r => r.json());
  expect(stopped.meta.status).toBe("stopped");
  expect(stopped.meta.endedAt).toBeDefined();

  const meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("stopped");
  expect(ctx.clients.has(sid)).toBe(false);
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

test("escalation numbering stays monotonic after a resolve archives the file", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, { slug: "first", content: "A?" });
  await postJson(baseUrl, `/sessions/${sid}/escalations/001-first.md/resolve`, { content: "answer A" });
  const second = await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, { slug: "second", content: "B?" }).then(r => r.json());

  expect(second.filename).toBe("002-second.md");
  expect(second.seq).toBe(2);

  const askingDir = join(ctx.sessionsDir, sid, "asking");
  expect(readdirSync(askingDir).filter(f => f.endsWith(".md"))).toEqual(["002-second.md"]);
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
  expect(res.reports[0].read).toBe(false);
  expect(res.reports[1].filename).toBe("002-build.md");
  expect(res.reports[1].read).toBe(false);
});

test("POST /sessions/:id/reports/:filename/read marks a report as read", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "the plan" });
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "build", content: "build result" });

  const marked = await postJson(baseUrl, `/sessions/${sid}/reports/001-plan.md/read`, {}).then(r => r.json());
  expect(marked.ok).toBe(true);
  expect(marked.read).toBe(true);

  const res = await fetch(`${baseUrl}/sessions/${sid}/reports`).then(r => r.json());
  const byName = Object.fromEntries(res.reports.map((r: { filename: string; read: boolean }) => [r.filename, r.read]));
  expect(byName["001-plan.md"]).toBe(true);
  expect(byName["002-build.md"]).toBe(false);

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.some(e => e.kind === "report_read")).toBe(true);
});

test("POST /sessions/:id/reports/:filename/unread reverts read state", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "the plan" });
  await postJson(baseUrl, `/sessions/${sid}/reports/001-plan.md/read`, {});
  const reverted = await postJson(baseUrl, `/sessions/${sid}/reports/001-plan.md/unread`, {}).then(r => r.json());
  expect(reverted.read).toBe(false);

  const res = await fetch(`${baseUrl}/sessions/${sid}/reports`).then(r => r.json());
  expect(res.reports[0].read).toBe(false);

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.some(e => e.kind === "report_unread")).toBe(true);
});

test("POST /sessions/:id/reports/read-all marks every report read and emits one event", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "the plan" });
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "step", content: "step done" });
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "more", content: "more" });
  await postJson(baseUrl, `/sessions/${sid}/reports/002-step.md/read`, {});

  const seqBefore = (await readEvents(sid, 1, ctx.sessionsDir)).at(-1)?.seq ?? 0;
  const result = await postJson(baseUrl, `/sessions/${sid}/reports/read-all`, {}).then(r => r.json());
  expect(result.ok).toBe(true);
  expect(result.read.sort()).toEqual(["001-plan.md", "003-more.md"]);

  const res = await fetch(`${baseUrl}/sessions/${sid}/reports`).then(r => r.json());
  expect(res.reports.every((r: { read: boolean }) => r.read)).toBe(true);

  const newEvents = (await readEvents(sid, 1, ctx.sessionsDir)).filter(e => e.seq > seqBefore);
  expect(newEvents).toHaveLength(1);
  expect(newEvents[0].kind).toBe("report_read");
  expect((newEvents[0].payload as { filenames: string[] }).filenames.sort()).toEqual(["001-plan.md", "003-more.md"]);

  const sessions = await fetch(`${baseUrl}/sessions`).then(r => r.json());
  expect(sessions.sessions.find((s: { id: string }) => s.id === sid).unreadReportCount).toBe(0);
});

test("POST /sessions/:id/reports/read-all is a no-op (no event) when nothing is unread", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  const seqBefore = (await readEvents(sid, 1, ctx.sessionsDir)).at(-1)?.seq ?? 0;
  const result = await postJson(baseUrl, `/sessions/${sid}/reports/read-all`, {}).then(r => r.json());
  expect(result.ok).toBe(true);
  expect(result.read).toEqual([]);
  const newEvents = (await readEvents(sid, 1, ctx.sessionsDir)).filter(e => e.seq > seqBefore);
  expect(newEvents).toEqual([]);
});

test("POST /sessions/:id/reports/:filename/read returns 404 for missing report", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  const res = await postJson(baseUrl, `/sessions/${sid}/reports/nope.md/read`, {});
  expect(res.status).toBe(404);
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

test("GET /sessions/:id/diff returns full file context (unchanged lines included)", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  // Commit a 30-line file to the base branch, then change one line deep in the
  // middle in the worktree. The default `git diff -U3` would hide lines 1-30
  // except a few around the change; the endpoint must include all of them.
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(repoDir, "many.txt"), lines.join("\n") + "\n");
  git(["add", "many.txt"], repoDir);
  git(["commit", "-m", "add many.txt"], repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;
  const wt = created.meta.worktreePath;

  const changed = [...lines];
  changed[14] = "line 15 CHANGED";
  writeFileSync(join(wt, "many.txt"), changed.join("\n") + "\n");

  const diff = await fetch(`${baseUrl}/sessions/${sid}/diff`).then(r => r.text());
  expect(diff).toContain("line 15 CHANGED");
  // Lines far from the change are present too because we requested full context.
  expect(diff).toContain("line 1");
  expect(diff).toContain("line 30");
});

test("GET /sessions/:id/diff shows the branch's own changes, not commits the base branch gained after the fork", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;
  const wt = created.meta.worktreePath;

  // The session commits its own work on the branch.
  writeFileSync(join(wt, "session-file.txt"), "session work\n");
  git(["add", "session-file.txt"], wt);
  git(["commit", "-m", "session change"], wt);

  // Meanwhile the base branch moves on past the worktree's fork point — e.g.
  // another session got merged in.
  writeFileSync(join(repoDir, "other-session.txt"), "work from another session\n");
  git(["add", "other-session.txt"], repoDir);
  git(["commit", "-m", "merge another session"], repoDir);

  const diff = await fetch(`${baseUrl}/sessions/${sid}/diff`).then(r => r.text());
  expect(diff).toContain("session-file.txt");
  expect(diff).not.toContain("other-session.txt");
});

test("GET /sessions/:id/files lists worktree files including new untracked ones", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;
  const wt = created.meta.worktreePath;
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src", "new.ts"), "export const x = 1;\n");

  const res = await fetch(`${baseUrl}/sessions/${sid}/files`).then(r => r.json());
  expect(res.paths).toContain("README.md");
  expect(res.paths).toContain("src/new.ts");
  // the worqload-injected symlink is not project content and points outside the worktree
  expect(res.paths).not.toContain(".worqload-reports");
});

test("GET /sessions/:id/file returns text content of a worktree file", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "notes.txt"), "alpha\nbeta\n");

  const res = await fetch(`${baseUrl}/sessions/${sid}/file?path=notes.txt`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe("notes.txt");
  expect(body.content).toBe("alpha\nbeta\n");
});

test("GET /sessions/:id/file rejects paths that escape the worktree", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  const res = await fetch(`${baseUrl}/sessions/${sid}/file?path=${encodeURIComponent("../".repeat(20) + "etc/hosts")}`);
  expect(res.status).toBe(403);
});

test("GET /sessions/:id/file returns 404 for a missing file and 400 without a path", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  expect((await fetch(`${baseUrl}/sessions/${sid}/file?path=nope.txt`)).status).toBe(404);
  expect((await fetch(`${baseUrl}/sessions/${sid}/file`)).status).toBe(400);
});

test("GET /sessions/:id/file flags binary files instead of returning their bytes", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "blob.bin"), Buffer.from([0x68, 0x69, 0x00, 0x03, 0xff]));

  const body = await fetch(`${baseUrl}/sessions/${sid}/file?path=blob.bin`).then(r => r.json());
  expect(body.binary).toBe(true);
  expect(body.content).toBeUndefined();
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

test("POST /sessions/:id/title sets, updates and clears the display title", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", {
    prompt: "あなたに長いお願いごとをしたいです、これはサイドバーで読みにくい",
    baseBranch: TEST_BASE,
  }).then(r => r.json());
  const sid = created.meta.id;
  expect(created.meta.title).toBeUndefined();

  // set
  const set = await postJson(baseUrl, `/sessions/${sid}/title`, { title: "  リファクタ祭り  " }).then(r => r.json());
  expect(set.meta.title).toBe("リファクタ祭り");
  expect((await loadSessionMeta(sid, ctx.sessionsDir))?.title).toBe("リファクタ祭り");
  expect((await fetch(`${baseUrl}/sessions/${sid}`).then(r => r.json())).meta.title).toBe("リファクタ祭り");

  // update
  const updated = await postJson(baseUrl, `/sessions/${sid}/title`, { title: "別名" }).then(r => r.json());
  expect(updated.meta.title).toBe("別名");

  // clear (empty / whitespace → drop the field, fall back to the prompt)
  const cleared = await postJson(baseUrl, `/sessions/${sid}/title`, { title: "   " }).then(r => r.json());
  expect(cleared.meta.title).toBeUndefined();
  expect((await loadSessionMeta(sid, ctx.sessionsDir))?.title).toBeUndefined();

  // surfaced in the session list too
  const list = await fetch(`${baseUrl}/sessions`).then(r => r.json());
  expect(list.sessions.find((s: { id: string }) => s.id === sid)?.title).toBeUndefined();
});

test("POST /sessions/:id/title rejects a non-string title and an unknown session", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  expect((await postJson(baseUrl, `/sessions/${created.meta.id}/title`, { title: 123 })).status).toBe(400);
  expect((await postJson(baseUrl, `/sessions/${created.meta.id}/title`, {})).status).toBe(400);
  expect((await postJson(baseUrl, "/sessions/nope/title", { title: "x" })).status).toBe(404);
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

test("startServer reconnects to a still-running host across a serve restart", async () => {
  const repoDir = makeRepo();
  const first = await startServer({
    port: 0,
    repoDir,
    spawnCommand: ["bun", MOCK, "hang"],
    branchNameGenerator: async () => null,
    hostCommand: HOST_COMMAND,
  });
  const baseUrl1 = `http://127.0.0.1:${first.server.port}`;
  const created = await postJson(baseUrl1, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  // Simulate a graceful serve restart: stop the HTTP server but leave hosts
  // alone. This is the whole point of Plan B.
  await first.shutdown(); // killHosts defaults to false

  const second = await startServer({
    port: 0,
    repoDir,
    spawnCommand: ["bun", MOCK, "hang"],
    branchNameGenerator: async () => null,
    hostCommand: HOST_COMMAND,
  });
  trackCleanup(() => second.shutdown({ killHosts: true }));
  const baseUrl2 = `http://127.0.0.1:${second.server.port}`;

  const detail = await fetch(`${baseUrl2}/sessions/${sid}`).then(r => r.json());
  expect(detail.meta.status).toBe("running");
  expect(detail.meta.endedAt).toBeUndefined();

  // The agent-endpoint file must now point at the second server, so the
  // agent CLI follows it across the restart.
  const endpointFile = agentEndpointPath(second.ctx.sessionsDir, sid);
  expect(readFileSync(endpointFile, "utf8").trim()).toBe(`http://127.0.0.1:${second.server.port}`);

  // shutdown({killHosts:true}) on a reconnected server must still kill the
  // host even though we don't own its Subprocess handle.
  const hostPid = detail.meta.hostPid as number;
  expect(typeof hostPid).toBe("number");
  await second.shutdown({ killHosts: true });
  // small grace for the signal to land
  await new Promise(r => setTimeout(r, 100));
  let alive = true;
  try { process.kill(hostPid, 0); } catch { alive = false; }
  expect(alive).toBe(false);
});

test("startServer marks a session crashed when its host is dead on boot", async () => {
  const repoDir = makeRepo();
  const first = await startServer({
    port: 0,
    repoDir,
    spawnCommand: ["bun", MOCK, "hang"],
    branchNameGenerator: async () => null,
    hostCommand: HOST_COMMAND,
  });
  const baseUrl1 = `http://127.0.0.1:${first.server.port}`;
  const created = await postJson(baseUrl1, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  // Kill the host. Session meta still says "running" — that's the orphan
  // condition reconcileNonTerminalSessions has to detect.
  await first.shutdown({ killHosts: true });

  const second = await startServer({
    port: 0,
    repoDir,
    spawnCommand: ["bun", MOCK, "hang"],
    branchNameGenerator: async () => null,
    hostCommand: HOST_COMMAND,
  });
  trackCleanup(() => second.shutdown({ killHosts: true }));
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

test("POST /sessions/:id/resume respawns the host and returns the session to running", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;
  await new Promise(r => setTimeout(r, 100));

  await postJson(baseUrl, `/sessions/${sid}/stop`, {});
  expect(ctx.clients.has(sid)).toBe(false);
  let meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("stopped");
  expect(meta?.endedAt).toBeDefined();

  const resumed = await postJson(baseUrl, `/sessions/${sid}/resume`, {}).then(r => r.json());
  expect(resumed.meta.status).toBe("running");
  expect(resumed.meta.endedAt).toBeUndefined();
  expect(ctx.clients.has(sid)).toBe(true);

  meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("running");
  expect(meta?.endedAt).toBeUndefined();
});

test("POST /sessions/:id/resume queues the optional prompt as feedback", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;
  await new Promise(r => setTimeout(r, 100));
  await postJson(baseUrl, `/sessions/${sid}/stop`, {});

  await postJson(baseUrl, `/sessions/${sid}/resume`, { prompt: "now do the other thing" });

  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  const files = readdirSync(inboxDir);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/-resume\.md$/);
  expect(readFileSync(join(inboxDir, files[0]), "utf8")).toContain("now do the other thing");
});

test("POST /sessions/:id/resume rejects a session that is still running", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  const res = await postJson(baseUrl, `/sessions/${sid}/resume`, {});
  expect(res.status).toBe(400);
});

test("POST /sessions/:id/resume rejects a cancelled session whose worktree is gone", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;
  await new Promise(r => setTimeout(r, 100));
  await postJson(baseUrl, `/sessions/${sid}/cancel`, {});
  expect(existsSync(created.meta.worktreePath)).toBe(false);

  const res = await postJson(baseUrl, `/sessions/${sid}/resume`, {});
  expect(res.status).toBe(400);
});

test("GET / serves the built HTML shell referencing the hashed /assets bundles", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const res = await fetch(`${baseUrl}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const body = await res.text();
  expect(body).toMatch(/<script[^>]+src="\/assets\/[^"]+\.js"/);
  expect(body).toMatch(/<link[^>]+href="\/assets\/[^"]+\.css"/);
});

test("the /assets bundles referenced by index.html are all reachable", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const html = await (await fetch(`${baseUrl}/`)).text();
  const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  expect(refs.length).toBeGreaterThan(0);
  const statuses = Object.fromEntries(
    await Promise.all(refs.map(async (ref) => [ref, (await fetch(`${baseUrl}${ref}`)).status] as const)),
  );
  expect(statuses).toEqual(Object.fromEntries(refs.map((ref) => [ref, 200])));
});

test("GET /assets/<unknown> returns 404", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const res = await fetch(`${baseUrl}/assets/nope.js`);
  expect(res.status).toBe(404);
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

test("invoking an action records an action_invoked event so the run log persists", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");
  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  // dirty the main repo so merge-to-base fails predictably; we only care that
  // the attempt (failure included) is recorded.
  writeFileSync(join(repoDir, "scratch.txt"), "dirt\n");
  Bun.spawnSync(["git", "add", "scratch.txt"], { cwd: repoDir, env: cleanGitEnv });
  await postJson(baseUrl, `/sessions/${sid}/actions/merge-to-base`, {});

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  const invoked = events.filter(e => e.kind === "action_invoked");
  expect(invoked.length).toBe(1);
  const payload = invoked[0].payload as { actionId: string; ok: boolean };
  expect(payload.actionId).toBe("merge-to-base");
  expect(payload.ok).toBe(false);
});

test("command approval: request creates asking + sidecar, sets waiting_human, getAsking exposes the command", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  const dangerousCommand = "npm publish --access public";
  const req = await postJson(baseUrl, `/internal/sessions/${sid}/command-approvals`, {
    command: dangerousCommand,
    reason: "release the package",
  }).then(r => r.json());
  expect(req.filename).toBe("001-command-approval.md");

  const askingDir = join(ctx.sessionsDir, sid, "asking");
  expect(readdirSync(askingDir).sort()).toEqual(["001-command-approval.command.json", "001-command-approval.md"]);
  expect(JSON.parse(readFileSync(join(askingDir, "001-command-approval.command.json"), "utf8")).command).toBe(dangerousCommand);

  const meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("waiting_human");

  const asking = await fetch(`${baseUrl}/sessions/${sid}/asking`).then(r => r.json());
  expect(asking.asking).toHaveLength(1);
  expect(asking.asking[0].command).toBe(dangerousCommand);
  expect(asking.asking[0].content).toContain("REQUIRE APPROVAL");
});

test("command approval: approve runs the command in the worktree and feeds back its output", async () => {
  const repoDir = makeRepo();
  const { baseUrl, ctx } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/command-approvals`, { command: "echo approved-ok" });

  const resolved = await postJson(baseUrl, `/sessions/${sid}/escalations/001-command-approval.md/resolve`, {
    decision: "approve",
  }).then(r => r.json());
  expect(resolved.ok).toBe(true);
  expect(resolved.exitCode).toBe(0);
  expect(resolved.stdout).toContain("approved-ok");

  const askingDir = join(ctx.sessionsDir, sid, "asking");
  expect(readdirSync(askingDir).filter(f => f.endsWith(".md") || f.endsWith(".json"))).toEqual([]);
  expect(readdirSync(join(askingDir, "resolved")).sort()).toEqual(["001-command-approval.command.json", "001-command-approval.md"]);

  const detail = await fetch(`${baseUrl}/sessions/${sid}`).then(r => r.json());
  expect(detail.meta.status).toBe("running");

  const inbox = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then(r => r.json());
  expect(inbox.messages).toHaveLength(1);
  expect(inbox.messages[0].content).toContain("approved this command");
  expect(inbox.messages[0].content).toContain("approved-ok");
  expect(inbox.messages[0].content).toContain("Exit code");

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  const resolvedEvent = events.find(e => e.kind === "escalation_resolved");
  const resolvedPayload = resolvedEvent?.payload as { decision?: string; exitCode?: number; stdout?: string };
  expect(resolvedPayload?.decision).toBe("approve");
  expect(resolvedPayload?.exitCode).toBe(0);
  expect(resolvedPayload?.stdout).toContain("approved-ok");
});

test("command approval: reject does not run the command and feeds back the rejection", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  const marker = join(repoDir, "should-not-exist");
  await postJson(baseUrl, `/internal/sessions/${sid}/command-approvals`, { command: `touch ${JSON.stringify(marker)}` });

  const resolved = await postJson(baseUrl, `/sessions/${sid}/escalations/001-command-approval.md/resolve`, {
    decision: "reject",
    content: "we never touch that path",
  }).then(r => r.json());
  expect(resolved.ok).toBe(true);
  expect(existsSync(marker)).toBe(false);

  const inbox = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then(r => r.json());
  expect(inbox.messages[0].content).toContain("rejected this command");
  expect(inbox.messages[0].content).toContain("we never touch that path");
});

test("command approval: resolve without a decision is rejected", async () => {
  const repoDir = makeRepo();
  const { baseUrl } = await bootServer(repoDir, "hang");

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then(r => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/command-approvals`, { command: "echo hi" });
  const res = await postJson(baseUrl, `/sessions/${sid}/escalations/001-command-approval.md/resolve`, { content: "yes please" });
  expect(res.status).toBe(400);
});
