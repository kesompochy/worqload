import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { appendEvent, readEvents } from "./event-log";
import { agentEndpointPath, hostLogPath, loadSessionMeta } from "./session";
import {
  cleanupAll,
  fakeWorktreeOps,
  inProcessHostLauncher,
  makeRepoFromTemplate,
  makeTmpDir,
  trackCleanup,
} from "./test-helpers";
import { type HostLauncher, startServer } from "./web-server";

afterEach(cleanupAll);

const cleanGitEnv = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };
const TEST_BASE = "trunk";
const MOCK = join(import.meta.dir, "__fixtures__", "mock-claude.ts");
const CLI = join(import.meta.dir, "cli.ts");
// `bun <cli> session-host` is the same binding `worqload session-host` invokes
// after `bun link`. Only the tests that depend on a live host subprocess
// (restart/reconnect, orphan detection) use this; everything else runs the host
// in-process via `inProcessHostLauncher`.
const HOST_COMMAND = ["bun", CLI, "session-host"];

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: cleanGitEnv });
}

// A real git repo, needed only by the handful of tests that exercise the real
// worktree/merge machinery (or a real host subprocess) end to end.
function makeGitRepo(): string {
  return makeRepoFromTemplate("web-server", (dir) => {
    git(["init"], dir);
    git(["checkout", "-b", TEST_BASE], dir);
    git(["config", "user.email", "t@t.com"], dir);
    git(["config", "user.name", "t"], dir);
    writeFileSync(join(dir, "README.md"), "# t\n");
    writeFileSync(join(dir, ".gitignore"), ".worqload/\n.worqload-reports\n.worktrees/\n");
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
  });
}

// The default test server: an fs-only worktree layer and an in-process host, so
// no `git` runs and no subprocesses are spawned. `repoDir` is just a directory.
async function bootServer(repoDir: string, extra: Partial<Parameters<typeof startServer>[0]> = {}) {
  const started = await startServer({
    port: 0,
    repoDir,
    // Skip real claude branch-name generation so the test doesn't depend on
    // `claude` being on PATH; resolveBranchName falls back to <shortId>.
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    // Default to pass-through so report tests don't spawn the real claude the
    // production rewriter would; the rewrite-specific tests override this.
    reportRewriter: async (raw) => raw,
    ...extra,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  return { ...started, baseUrl: `http://127.0.0.1:${started.server.port}` };
}

// Like `bootServer` but with the real git/worktree layer — for tests that drive
// `worktree`/`actions` operations (diff, merge-to-base) through the HTTP layer
// against an actual git repo.
async function bootServerRealGit(repoDir: string) {
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
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
  const repoDir1 = makeTmpDir("repo");
  const repoDir2 = makeTmpDir("repo");

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
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const res = await fetch(`${baseUrl}/meta`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.repoDir).toBe(repoDir);
  expect(body.repoName).toBe(repoDir.split("/").pop());
});

test("POST /sessions creates a session, worktree, meta.json", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

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
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const res = await postJson(baseUrl, "/sessions", {
    prompt: "do thing",
    baseBranch: TEST_BASE,
    branchName: "fix-login-bug",
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.meta.branchName).toBe("fix-login-bug");
  // That the branch is actually created under this name is `worktree`'s job and
  // is covered by worktree.test.ts ("uses the supplied branch name verbatim").
});

test("POST /sessions uses generated branch name when no explicit one is given", async () => {
  const repoDir = makeTmpDir("repo");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => "auto-name",
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
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
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const res = await postJson(baseUrl, "/sessions", {
    prompt: "do thing",
    baseBranch: TEST_BASE,
    branchName: "-leading-dash",
  });
  expect(res.status).toBe(400);
});

test("GET /sessions lists created sessions", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  await postJson(baseUrl, "/sessions", { prompt: "first", baseBranch: TEST_BASE });
  await postJson(baseUrl, "/sessions", { prompt: "second", baseBranch: TEST_BASE });

  const res = await fetch(`${baseUrl}/sessions`);
  const body = await res.json();
  expect(body.sessions).toHaveLength(2);
});

test("POST /sessions/order persists the sidebar order", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const a = await postJson(baseUrl, "/sessions", { prompt: "first", baseBranch: TEST_BASE }).then((r) => r.json());
  const b = await postJson(baseUrl, "/sessions", { prompt: "second", baseBranch: TEST_BASE }).then((r) => r.json());
  const c = await postJson(baseUrl, "/sessions", { prompt: "third", baseBranch: TEST_BASE }).then((r) => r.json());
  const ids = [a.meta.id, b.meta.id, c.meta.id];

  const res = await postJson(baseUrl, "/sessions/order", { ids });
  expect(res.status).toBe(200);

  const body = await fetch(`${baseUrl}/sessions`).then((r) => r.json());
  expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(ids);
});

test("POST /sessions/order rejects a non-string-array body", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);
  const res = await postJson(baseUrl, "/sessions/order", { ids: "nope" });
  expect(res.status).toBe(400);
});

test("GET /sessions exposes unread report counts per session", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const a = await postJson(baseUrl, "/sessions", { prompt: "with reports", baseBranch: TEST_BASE }).then((r) =>
    r.json(),
  );
  const b = await postJson(baseUrl, "/sessions", { prompt: "no reports", baseBranch: TEST_BASE }).then((r) => r.json());
  const aid = a.meta.id;
  const bid = b.meta.id;

  await postJson(baseUrl, `/internal/sessions/${aid}/reports`, { slug: "plan", content: "the plan" });
  await postJson(baseUrl, `/internal/sessions/${aid}/reports`, { slug: "step", content: "step done" });
  await postJson(baseUrl, `/internal/sessions/${aid}/reports`, { slug: "more", content: "more progress" });
  await postJson(baseUrl, `/sessions/${aid}/reports/001-plan.md/read`, {});

  const body = await fetch(`${baseUrl}/sessions`).then((r) => r.json());
  const byId = Object.fromEntries(body.sessions.map((s: { id: string; unreadReportCount: number }) => [s.id, s]));
  expect(byId[aid].unreadReportCount).toBe(2);
  expect(byId[bid].unreadReportCount).toBe(0);
});

test("GET /sessions exposes unresolved escalation counts per session", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const a = await postJson(baseUrl, "/sessions", { prompt: "with escalations", baseBranch: TEST_BASE }).then((r) =>
    r.json(),
  );
  const b = await postJson(baseUrl, "/sessions", { prompt: "none", baseBranch: TEST_BASE }).then((r) => r.json());
  const aid = a.meta.id;
  const bid = b.meta.id;

  await postJson(baseUrl, `/internal/sessions/${aid}/escalations`, { slug: "first", content: "A?" });
  await postJson(baseUrl, `/internal/sessions/${aid}/escalations`, { slug: "second", content: "B?" });
  await postJson(baseUrl, `/sessions/${aid}/escalations/001-first.md/resolve`, { content: "answer A" });

  const body = await fetch(`${baseUrl}/sessions`).then((r) => r.json());
  const byId = Object.fromEntries(
    body.sessions.map((s: { id: string; unresolvedEscalationCount: number }) => [s.id, s]),
  );
  expect(byId[aid].unresolvedEscalationCount).toBe(1);
  expect(byId[bid].unresolvedEscalationCount).toBe(0);
});

test("GET /sessions exposes the last agent-work event timestamp, ignoring reports", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const work = await appendEvent(sid, { kind: "claude_tool_use", payload: { name: "Read" } }, ctx.sessionsDir);
  // A later event that is *not* agent work — it must not move the timestamp.
  await appendEvent(sid, { kind: "report_submitted", payload: { filename: "001-x.md" } }, ctx.sessionsDir);

  const body = await fetch(`${baseUrl}/sessions`).then((r) => r.json());
  const session = body.sessions.find((s: { id: string }) => s.id === sid);
  expect(session.lastAgentEventAt).toBe(work.timestamp);
});

test("POST /internal/sessions/:id/reports writes numbered report", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const r1 = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, {
    slug: "plan",
    content: "this is the plan",
  }).then((r) => r.json());
  expect(r1.filename).toBe("001-plan.md");
  expect(r1.seq).toBe(1);

  const r2 = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, {
    slug: "build-failed",
    content: "stuff broke",
  }).then((r) => r.json());
  expect(r2.filename).toBe("002-build-failed.md");

  const reportsDir = join(ctx.sessionsDir, sid, "reports");
  expect(readdirSync(reportsDir).sort()).toEqual(["001-plan.md", "002-build-failed.md"]);
  const events = await readEvents(sid, 1, ctx.sessionsDir);
  const reportEvents = events.filter((e) => e.kind === "report_submitted");
  expect(reportEvents).toHaveLength(2);
});

test("a submitted report is run through the report rewriter before being stored (flag defaults ON)", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir, {
    reportRewriter: async (raw, { cwd }) => `整形済み(${cwd ? "cwd-ok" : "no-cwd"}): ${raw}`,
  });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const r = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "なまの本文" }).then(
    (r) => r.json(),
  );
  const stored = readFileSync(join(ctx.sessionsDir, sid, "reports", r.filename), "utf8");
  expect(stored).toBe("整形済み(cwd-ok): なまの本文");
});

test("toggling reportAgentEnabled off stores the report raw; toggling back on restores rewriting", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir, {
    reportRewriter: async (raw) => `REWRITTEN: ${raw}`,
  });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const off = await postJson(baseUrl, `/sessions/${sid}/report-agent`, { enabled: false }).then((r) => r.json());
  expect(off.meta.reportAgentEnabled).toBe(false);
  const detail = await fetch(`${baseUrl}/sessions/${sid}`).then((r) => r.json());
  expect(detail.meta.reportAgentEnabled).toBe(false);

  const r1 = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "raw", content: "素のまま" }).then(
    (r) => r.json(),
  );
  expect(readFileSync(join(ctx.sessionsDir, sid, "reports", r1.filename), "utf8")).toBe("素のまま");

  const on = await postJson(baseUrl, `/sessions/${sid}/report-agent`, { enabled: true }).then((r) => r.json());
  expect(on.meta.reportAgentEnabled).toBe(true);

  const r2 = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, {
    slug: "polished",
    content: "また整形",
  }).then((r) => r.json());
  expect(readFileSync(join(ctx.sessionsDir, sid, "reports", r2.filename), "utf8")).toBe("REWRITTEN: また整形");
});

test("POST /sessions/:id/report-agent rejects a non-boolean enabled", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);
  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const res = await postJson(baseUrl, `/sessions/${created.meta.id}/report-agent`, { enabled: "yes" });
  expect(res.status).toBe(400);
});

test("POST /internal/sessions/:id/escalations sets status to waiting_human", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const e = await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, {
    slug: "which-lib",
    content: "X or Y?",
  }).then((r) => r.json());
  expect(e.filename).toBe("001-which-lib.md");

  const meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("waiting_human");
  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.some((ev) => ev.kind === "escalation_requested")).toBe(true);
});

test("feedback inbox round trip: POST writes, GET fetches and moves to read", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "hi there", slug: "say-hi" });
  await postJson(baseUrl, `/sessions/${sid}/feedback`, {
    content: "fix this please",
    slug: "fix-this",
    anchor: { path: "src/foo.ts", lineStart: 40, lineEnd: 45 },
  });

  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  // The anchored message gets a `.meta.json` sidecar; its body stays clean.
  expect(readdirSync(inboxDir).sort()).toEqual(["001-say-hi.md", "002-fix-this.md", "002-fix-this.meta.json"]);
  expect(readFileSync(join(inboxDir, "002-fix-this.md"), "utf8")).toBe("fix this please");
  expect(JSON.parse(readFileSync(join(inboxDir, "002-fix-this.meta.json"), "utf8"))).toEqual({
    anchor: { path: "src/foo.ts", lineStart: 40, lineEnd: 45 },
  });

  const fetched = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  expect(fetched.messages).toHaveLength(2);
  // The agent still sees the `Re:` line at the head of an anchored message.
  expect(fetched.messages[1].content).toBe("Re: src/foo.ts:40-45\n\nfix this please");

  // After fetch, inbox should be empty and read/ should contain them (sidecar too)
  expect(readdirSync(inboxDir)).toEqual([]);
  const readDir = join(ctx.sessionsDir, sid, "feedback", "read");
  expect(readdirSync(readDir).sort()).toEqual(["001-say-hi.md", "002-fix-this.md", "002-fix-this.meta.json"]);
});

test("worqload feedback fetch surfaces absolute attachment paths in the message body", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const form = new FormData();
  form.set("payload", JSON.stringify({ content: "see the screenshot", slug: "look" }));
  form.append("attachment", new File([png], "shot.png", { type: "image/png" }));
  form.append("attachment", new File([png], "design.webp", { type: "image/webp" }));
  await fetch(`${baseUrl}/sessions/${sid}/feedback`, { method: "POST", body: form });

  const fetched = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  expect(fetched.messages).toHaveLength(1);
  const expectedDir = join(ctx.sessionsDir, sid, "feedback", "read", "001-look.attachments");
  expect(fetched.messages[0].content).toBe(
    `see the screenshot\n\n## Attachments\n\n` +
      `The human attached 2 images. Read each with the Read tool:\n\n` +
      `- ${expectedDir}/01-shot.png\n` +
      `- ${expectedDir}/02-design.webp`,
  );
});

test("worqload feedback fetch leaves the body untouched when no attachments are present", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "plain message", slug: "plain" });

  const fetched = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  expect(fetched.messages[0].content).toBe("plain message");
});

test("GET /sessions/:id/feedback exposes attachments on each message", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const form = new FormData();
  form.set("payload", JSON.stringify({ content: "look", slug: "look" }));
  form.append("attachment", new File([png], "shot.png", { type: "image/png" }));
  await fetch(`${baseUrl}/sessions/${sid}/feedback`, { method: "POST", body: form });

  const history = await fetch(`${baseUrl}/sessions/${sid}/feedback`).then((r) => r.json());
  expect(history.messages).toHaveLength(1);
  expect(history.messages[0].filename).toBe("001-look.md");
  expect(history.messages[0].attachments).toEqual(["01-shot.png"]);
});

test("GET /sessions/:id/feedback/:filename/attachments/:name streams the bytes", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const form = new FormData();
  form.set("payload", JSON.stringify({ content: "see", slug: "see" }));
  form.append("attachment", new File([png], "shot.png", { type: "image/png" }));
  await fetch(`${baseUrl}/sessions/${sid}/feedback`, { method: "POST", body: form });

  const res = await fetch(`${baseUrl}/sessions/${sid}/feedback/001-see.md/attachments/01-shot.png`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  const body = new Uint8Array(await res.arrayBuffer());
  expect(body).toEqual(png);
});

test("GET attachments endpoint also serves files moved into the read dir", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const form = new FormData();
  form.set("payload", JSON.stringify({ content: "see", slug: "see" }));
  form.append("attachment", new File([png], "shot.png", { type: "image/png" }));
  await fetch(`${baseUrl}/sessions/${sid}/feedback`, { method: "POST", body: form });

  // Drain the inbox into read.
  await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());

  const res = await fetch(`${baseUrl}/sessions/${sid}/feedback/001-see.md/attachments/01-shot.png`);
  expect(res.status).toBe(200);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
});

test("GET attachments endpoint rejects path traversal in :name", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await fetch(
    `${baseUrl}/sessions/${sid}/feedback/001-x.md/attachments/${encodeURIComponent("../../../etc/passwd")}`,
  );
  expect(res.status).toBe(400);
});

test("POST /feedback (multipart) stores attachments in a sibling .attachments dir", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const form = new FormData();
  form.set("payload", JSON.stringify({ content: "see screenshot", slug: "look" }));
  form.append("attachment", new File([png], "Screenshot 2026-05-15.png", { type: "image/png" }));
  form.append("attachment", new File([png], "design.webp", { type: "image/webp" }));

  const res = await fetch(`${baseUrl}/sessions/${sid}/feedback`, { method: "POST", body: form });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.filename).toBe("001-look.md");

  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  expect(readFileSync(join(inboxDir, "001-look.md"), "utf8")).toBe("see screenshot");
  const attachDir = join(inboxDir, "001-look.attachments");
  expect(readdirSync(attachDir).sort()).toEqual(["01-Screenshot-2026-05-15.png", "02-design.webp"]);
  expect(new Uint8Array(readFileSync(join(attachDir, "01-Screenshot-2026-05-15.png")))).toEqual(png);
});

test("POST /feedback (multipart) rejects non-image MIME types", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const form = new FormData();
  form.set("payload", JSON.stringify({ content: "evil pdf", slug: "bad" }));
  form.append("attachment", new File([new Uint8Array([1, 2, 3])], "doc.pdf", { type: "application/pdf" }));

  const res = await fetch(`${baseUrl}/sessions/${sid}/feedback`, { method: "POST", body: form });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/image/);
});

test("POST /feedback (multipart) rejects an attachment exceeding the size cap", async () => {
  const repoDir = makeTmpDir("repo");
  // Tiny cap so the test stays fast and the body doesn't allocate megabytes.
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    feedbackAttachmentMaxBytes: 16,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const oversized = new Uint8Array(32);
  const form = new FormData();
  form.set("payload", JSON.stringify({ content: "too big", slug: "big" }));
  form.append("attachment", new File([oversized], "big.png", { type: "image/png" }));

  const res = await fetch(`${baseUrl}/sessions/${sid}/feedback`, { method: "POST", body: form });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/size/i);
});

test("POST /feedback (multipart) rejects more attachments than the per-request cap", async () => {
  const repoDir = makeTmpDir("repo");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    feedbackAttachmentMaxCount: 2,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const png = new Uint8Array([0x89]);
  const form = new FormData();
  form.set("payload", JSON.stringify({ content: "many", slug: "many" }));
  form.append("attachment", new File([png], "a.png", { type: "image/png" }));
  form.append("attachment", new File([png], "b.png", { type: "image/png" }));
  form.append("attachment", new File([png], "c.png", { type: "image/png" }));

  const res = await fetch(`${baseUrl}/sessions/${sid}/feedback`, { method: "POST", body: form });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/too many/i);
});

test("POST /feedback appends a wake_sent entry to host.log", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "wake me", slug: "wake" });

  const logPath = hostLogPath(ctx.sessionsDir, sid);
  expect(existsSync(logPath)).toBe(true);
  const entries = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const wake = entries.find((e) => e.event === "wake_sent");
  expect(wake).toBeDefined();
  expect(wake?.source).toBe("serve");
  expect(wake?.filename).toBe("001-wake.md");
  expect(wake?.hasClient).toBe(true);
  expect(wake?.status).toBe("running");
});

// Regression: previously the wake was logged-and-dropped when `ctx.clients` had
// no entry for the session — the file got into the inbox but the agent never
// learned about it until something else (a future fetch, a manual resume) ran.
// Now we treat the missing attachment the same way the wake watchdog treats a
// silent claude: respawn the host with `resume: true` so RESUME_KICKOFF makes
// the new agent pick up the feedback inbox immediately.
test("POST /feedback respawns the host when the session is running but the client attachment is gone", async () => {
  const repoDir = makeTmpDir("repo");
  const launches: { resume: boolean }[] = [];
  const baseLauncher = inProcessHostLauncher();
  const countingLauncher: HostLauncher = async (req) => {
    launches.push({ resume: req.resume });
    return baseLauncher(req);
  };
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: countingLauncher,
    worktreeOps: fakeWorktreeOps(),
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;
  const ctx = started.ctx;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  expect(launches).toEqual([{ resume: false }]);

  // Simulate the unix socket between serve and host dropping without the host
  // process dying: the entry in ctx.clients disappears, but meta.status stays
  // "running". This is the shape host.log entries with `hasClient: false`
  // record post-hoc.
  ctx.clients.delete(sid);

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "wake me", slug: "wake" });

  // Respawn fired with resume=true. The new host's RESUME_KICKOFF will make
  // claude `worqload feedback fetch`, picking up the message we just wrote.
  expect(launches).toEqual([{ resume: false }, { resume: true }]);
  expect(ctx.clients.has(sid)).toBe(true);

  const meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("running");

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.some((e) => e.kind === "session_auto_resumed")).toBe(true);
});

test("wake watchdog auto-resumes when no claude_* event arrives within the threshold", async () => {
  const repoDir = makeTmpDir("repo");
  // Pin the watchdog short so the test isn't flaky.
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    wakeWatchdogMs: 60,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;
  const ctx = started.ctx;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "wake me", slug: "wake" });

  // Allow the watchdog to fire and run the resume path.
  await new Promise((r) => setTimeout(r, 250));

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  const kinds = events.map((e) => e.kind);
  expect(kinds).toContain("session_auto_resumed");
  // The respawn should write a fresh session_resumed (in addition to the
  // original session_started).
  expect(kinds.filter((k) => k === "session_resumed").length).toBeGreaterThanOrEqual(1);

  const auto = events.find((e) => e.kind === "session_auto_resumed");
  // Feedback is queued and was never fetched, so the inbox-still-full trigger
  // is the precise diagnosis (it subsumes "no claude_* event arrived").
  expect((auto?.payload as Record<string, unknown>).reason).toBe("feedback_unfetched");
});

test("wake watchdog stays quiet when the agent actually fetched the feedback", async () => {
  const repoDir = makeTmpDir("repo");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    wakeWatchdogMs: 100,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;
  const ctx = started.ctx;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "wake me", slug: "wake" });
  // A real `worqload feedback fetch` is a Bash tool call inside a claude turn:
  // it drains the inbox AND the surrounding turn emits claude_* events. Model
  // both. (Either alone would still resume — the inbox must be drained, and a
  // drained inbox with a since-dead claude is still worth recovering.)
  await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  ctx.lastClaudeActivityAt.set(sid, Date.now() + 1);

  await new Promise((r) => setTimeout(r, 250));

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.some((e) => e.kind === "session_auto_resumed")).toBe(false);
});

// Regression: the structural feedback-delivery bug. The wake watchdog used to
// treat "claude emitted any claude_* event after the wake" as proof the
// feedback was handled. It is not: when feedback arrives mid-turn the wake is
// only queued (and with the tmux driver, pasted into a busy TUI — often lost
// entirely) while claude keeps emitting events for its current work, ending
// with a `turn_duration` system event. The agent never runs `worqload
// feedback fetch`, the file rots in the inbox, and the session sits idle. The
// watchdog must key off the inbox itself, not claude activity.
test("wake watchdog auto-resumes when claude is active but the feedback inbox was never drained", async () => {
  const repoDir = makeTmpDir("repo");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    wakeWatchdogMs: 60,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;
  const ctx = started.ctx;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "wake me", slug: "wake" });
  // Claude is mid-turn: it keeps emitting events after the wake (the old
  // predicate `lastClaudeActivityAt >= wakeAt` is satisfied) but never fetches.
  ctx.lastClaudeActivityAt.set(sid, Date.now() + 1);

  await new Promise((r) => setTimeout(r, 250));

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  const auto = events.find((e) => e.kind === "session_auto_resumed");
  expect(auto).toBeDefined();
  expect((auto?.payload as Record<string, unknown>).reason).toBe("feedback_unfetched");

  // The inbox is drained by the respawn path's RESUME_KICKOFF in production;
  // here we assert the recovery was triggered (a fresh session_resumed).
  expect(events.filter((e) => e.kind === "session_resumed").length).toBeGreaterThanOrEqual(1);
});

// Regression: streamed feedback used to defeat the watchdog. Each wake reset
// the 90s deadline, so a human appending feedback faster than the threshold
// kept postponing it forever — the inbox rotted undelivered with no recovery.
// The deadline must anchor to the FIRST still-undrained wake, not the latest:
// a later wake while earlier feedback is still unfetched does not buy more
// silence.
test("a second wake does not postpone the watchdog while earlier feedback is still undrained", async () => {
  const repoDir = makeTmpDir("repo");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    wakeWatchdogMs: 300,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;
  const ctx = started.ctx;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  // First wake: deadline armed ≈ now + 300ms.
  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "first", slug: "a" });
  // A second wake 100ms in, with the inbox still undrained. The old behavior
  // reset the timer (fire ≈ +400ms); the fixed behavior keeps it anchored to
  // the first wake (fire ≈ +300ms).
  await new Promise((r) => setTimeout(r, 100));
  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "second", slug: "b" });

  // ≈ +360ms total: past the first wake's deadline (300), before the deadline
  // a reset would have produced (400). The watchdog must already have fired.
  await new Promise((r) => setTimeout(r, 260));
  const events = await readEvents(sid, 1, ctx.sessionsDir);
  const auto = events.find((e) => e.kind === "session_auto_resumed");
  expect(auto).toBeDefined();
  expect((auto?.payload as Record<string, unknown>).reason).toBe("feedback_unfetched");
});

// The flip side of the anchor change: once the agent drains the inbox the
// watchdog goes quiet, and a subsequent wake must arm a fresh deadline — the
// "skip if already armed" guard must not permanently wedge the watchdog off.
test("a wake after the inbox was drained re-arms a fresh watchdog", async () => {
  const repoDir = makeTmpDir("repo");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    wakeWatchdogMs: 150,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;
  const ctx = started.ctx;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  // First wake, then the agent drains it (a real `worqload feedback fetch`):
  // the watchdog fires once, sees an empty + fetched inbox, and stays quiet.
  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "first", slug: "a" });
  await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  ctx.lastClaudeActivityAt.set(sid, Date.now() + 1);
  await new Promise((r) => setTimeout(r, 220));
  const quiet = await readEvents(sid, 1, ctx.sessionsDir);
  expect(quiet.some((e) => e.kind === "session_auto_resumed")).toBe(false);

  // A new wake now must arm a fresh watchdog (the prior one was cleared when it
  // fired and went quiet). Leave it undrained; it must fire.
  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "second", slug: "b" });
  await new Promise((r) => setTimeout(r, 220));
  const after = await readEvents(sid, 1, ctx.sessionsDir);
  const auto = after.find((e) => e.kind === "session_auto_resumed");
  expect(auto).toBeDefined();
  expect((auto?.payload as Record<string, unknown>).reason).toBe("feedback_unfetched");
});

test("a stale watchdog from a replaced attachment is a no-op", async () => {
  const repoDir = makeTmpDir("repo");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    wakeWatchdogMs: 80,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;
  const ctx = started.ctx;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  // Send a wake (watchdog A scheduled for +80ms).
  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "first", slug: "a" });

  // Before the watchdog can fire, simulate someone replacing the attachment
  // out from under it (e.g. user manually resumed, or another watchdog ran).
  const fresh: typeof ctx.clients extends Map<string, infer V> ? V : never = {
    client: {
      async send() {},
      async kill() {},
      async close() {},
      replayCompleted: Promise.resolve({ lastSeq: 0 }),
      exited: new Promise<number | null>(() => {}),
    },
    hostPid: 99999,
  };
  ctx.clients.set(sid, fresh);

  // Let the original watchdog fire; it should bail because att !== expectedAtt.
  await new Promise((r) => setTimeout(r, 200));
  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.some((e) => e.kind === "session_auto_resumed")).toBe(false);
});

test("wake watchdog disabled with wakeWatchdogMs=0 leaves a silent session alone", async () => {
  const repoDir = makeTmpDir("repo");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: fakeWorktreeOps(),
    wakeWatchdogMs: 0,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;
  const ctx = started.ctx;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "wake me", slug: "wake" });
  await new Promise((r) => setTimeout(r, 150));

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.some((e) => e.kind === "session_auto_resumed")).toBe(false);
});

test("POST /sessions/:id/wake sends a manual wake and logs it to host.log", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await postJson(baseUrl, `/sessions/${sid}/wake`, {}).then((r) => r.json());
  expect(res.ok).toBe(true);
  expect(res.sent).toBe(true);

  const logPath = hostLogPath(ctx.sessionsDir, sid);
  expect(existsSync(logPath)).toBe(true);
  const entries = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const wake = entries.find((e) => e.event === "wake_sent" && e.reason === "manual");
  expect(wake).toBeDefined();
  expect(wake?.hasClient).toBe(true);
  expect(wake?.status).toBe("running");
});

test("POST /sessions/:id/wake rejects a terminal session", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  await postJson(baseUrl, `/sessions/${sid}/stop`, {});

  const res = await fetch(`${baseUrl}/sessions/${sid}/wake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(400);
});

test("feedback numbering stays monotonic after a fetch drains the inbox", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "first", slug: "a" });
  await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  const second = await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "second", slug: "b" }).then((r) =>
    r.json(),
  );

  expect(second.filename).toBe("002-b.md");
  expect(second.seq).toBe(2);

  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  expect(readdirSync(inboxDir)).toEqual(["002-b.md"]);
});

test("POST /sessions/:id/stop kills the host and sets status stopped", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const stopped = await postJson(baseUrl, `/sessions/${sid}/stop`, {}).then((r) => r.json());
  expect(stopped.meta.status).toBe("stopped");
  expect(stopped.meta.endedAt).toBeDefined();

  const meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("stopped");
  expect(ctx.clients.has(sid)).toBe(false);
});

test("escalation resolve moves asking file, writes feedback, returns to running", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, { slug: "lib", content: "X or Y?" });

  // before resolve
  let detail = await fetch(`${baseUrl}/sessions/${sid}`).then((r) => r.json());
  expect(detail.meta.status).toBe("waiting_human");

  const resolved = await postJson(baseUrl, `/sessions/${sid}/escalations/001-lib.md/resolve`, {
    content: "go with X",
  }).then((r) => r.json());
  expect(resolved.ok).toBe(true);

  // status returned to running
  detail = await fetch(`${baseUrl}/sessions/${sid}`).then((r) => r.json());
  expect(detail.meta.status).toBe("running");

  // asking dir empty top-level, resolved/ has the file
  const askingTop = readdirSync(join(ctx.sessionsDir, sid, "asking"));
  expect(askingTop).toContain("resolved");
  expect(askingTop.filter((f) => f.endsWith(".md"))).toEqual([]);
  expect(readdirSync(join(ctx.sessionsDir, sid, "asking", "resolved"))).toEqual(["001-lib.md"]);

  // feedback inbox has the answer
  const inboxRes = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  expect(inboxRes.messages).toHaveLength(1);
  expect(inboxRes.messages[0].content).toContain("X or Y?");
  expect(inboxRes.messages[0].content).toContain("go with X");
});

test("escalation resolve returns 404 for missing file", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await fetch(`${baseUrl}/sessions/${sid}/escalations/nope.md/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "answer" }),
  });
  expect(res.status).toBe(404);
});

test("escalation resolve keeps waiting_human when other escalations remain", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, { slug: "first", content: "A?" });
  await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, { slug: "second", content: "B?" });

  await postJson(baseUrl, `/sessions/${sid}/escalations/001-first.md/resolve`, { content: "answer A" });

  const detail = await fetch(`${baseUrl}/sessions/${sid}`).then((r) => r.json());
  expect(detail.meta.status).toBe("waiting_human");
});

test("escalation numbering stays monotonic after a resolve archives the file", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, { slug: "first", content: "A?" });
  await postJson(baseUrl, `/sessions/${sid}/escalations/001-first.md/resolve`, { content: "answer A" });
  const second = await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, {
    slug: "second",
    content: "B?",
  }).then((r) => r.json());

  expect(second.filename).toBe("002-second.md");
  expect(second.seq).toBe(2);

  const askingDir = join(ctx.sessionsDir, sid, "asking");
  expect(readdirSync(askingDir).filter((f) => f.endsWith(".md"))).toEqual(["002-second.md"]);
});

test("GET /sessions/:id/reports returns all reports with content", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "the plan" });
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "build", content: "build result" });

  const res = await fetch(`${baseUrl}/sessions/${sid}/reports`).then((r) => r.json());
  expect(res.reports).toHaveLength(2);
  expect(res.reports[0].filename).toBe("001-plan.md");
  expect(res.reports[0].content).toBe("the plan");
  expect(res.reports[0].read).toBe(false);
  expect(res.reports[1].filename).toBe("002-build.md");
  expect(res.reports[1].read).toBe(false);
});

test("POST /sessions/:id/reports/:filename/read marks a report as read", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "the plan" });
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "build", content: "build result" });

  const marked = await postJson(baseUrl, `/sessions/${sid}/reports/001-plan.md/read`, {}).then((r) => r.json());
  expect(marked.ok).toBe(true);
  expect(marked.read).toBe(true);

  const res = await fetch(`${baseUrl}/sessions/${sid}/reports`).then((r) => r.json());
  const byName = Object.fromEntries(res.reports.map((r: { filename: string; read: boolean }) => [r.filename, r.read]));
  expect(byName["001-plan.md"]).toBe(true);
  expect(byName["002-build.md"]).toBe(false);

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.some((e) => e.kind === "report_read")).toBe(true);
});

test("POST /sessions/:id/reports/:filename/unread reverts read state", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "the plan" });
  await postJson(baseUrl, `/sessions/${sid}/reports/001-plan.md/read`, {});
  const reverted = await postJson(baseUrl, `/sessions/${sid}/reports/001-plan.md/unread`, {}).then((r) => r.json());
  expect(reverted.read).toBe(false);

  const res = await fetch(`${baseUrl}/sessions/${sid}/reports`).then((r) => r.json());
  expect(res.reports[0].read).toBe(false);

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.some((e) => e.kind === "report_unread")).toBe(true);
});

test("POST /sessions/:id/reports/read-all marks every report read and emits one event", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "the plan" });
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "step", content: "step done" });
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "more", content: "more" });
  await postJson(baseUrl, `/sessions/${sid}/reports/002-step.md/read`, {});

  const seqBefore = (await readEvents(sid, 1, ctx.sessionsDir)).at(-1)?.seq ?? 0;
  const result = await postJson(baseUrl, `/sessions/${sid}/reports/read-all`, {}).then((r) => r.json());
  expect(result.ok).toBe(true);
  expect(result.read.sort()).toEqual(["001-plan.md", "003-more.md"]);

  const res = await fetch(`${baseUrl}/sessions/${sid}/reports`).then((r) => r.json());
  expect(res.reports.every((r: { read: boolean }) => r.read)).toBe(true);

  const newEvents = (await readEvents(sid, 1, ctx.sessionsDir)).filter((e) => e.seq > seqBefore);
  expect(newEvents).toHaveLength(1);
  expect(newEvents[0].kind).toBe("report_read");
  expect((newEvents[0].payload as { filenames: string[] }).filenames.sort()).toEqual(["001-plan.md", "003-more.md"]);

  const sessions = await fetch(`${baseUrl}/sessions`).then((r) => r.json());
  expect(sessions.sessions.find((s: { id: string }) => s.id === sid).unreadReportCount).toBe(0);
});

test("POST /sessions/:id/reports/read-all is a no-op (no event) when nothing is unread", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const seqBefore = (await readEvents(sid, 1, ctx.sessionsDir)).at(-1)?.seq ?? 0;
  const result = await postJson(baseUrl, `/sessions/${sid}/reports/read-all`, {}).then((r) => r.json());
  expect(result.ok).toBe(true);
  expect(result.read).toEqual([]);
  const newEvents = (await readEvents(sid, 1, ctx.sessionsDir)).filter((e) => e.seq > seqBefore);
  expect(newEvents).toEqual([]);
});

test("POST /sessions/:id/reports/:filename/read returns 404 for missing report", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await postJson(baseUrl, `/sessions/${sid}/reports/nope.md/read`, {});
  expect(res.status).toBe(404);
});

// What `git diff` actually produces (full context, merge-base resolution, ...)
// is `worktree`'s contract — see worktree.test.ts. Here we only check that the
// /diff endpoint routes to the right worktreeOps call and passes its output
// through; the fake echoes its target so the routing is observable.
test("GET /sessions/:id/diff returns worktreeOps.gitDiff against the session-start commit", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const diffRes = await fetch(`${baseUrl}/sessions/${sid}/diff`);
  expect(diffRes.status).toBe(200);
  expect(diffRes.headers.get("content-type")).toContain("text/plain");
  const diff = await diffRes.text();
  expect(diff).toContain("diff against");
  expect(diff).toContain(created.meta.baseCommit);
});

// What `resolveDiffBase` / `git diff` actually compute (merge-base when the
// base branch advanced, full context, ...) is `worktree`'s contract — see
// worktree.test.ts.

test("GET /sessions/:id/files lists worktree files and hides the .worqload-reports symlink", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  const wt = created.meta.worktreePath;
  writeFileSync(join(wt, "README.md"), "# r\n");
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src", "new.ts"), "export const x = 1;\n");

  const res = await fetch(`${baseUrl}/sessions/${sid}/files`).then((r) => r.json());
  expect(res.paths).toContain("README.md");
  expect(res.paths).toContain("src/new.ts");
  // worqload-injected entries (the reports symlink and the draft scratch dir)
  // are not project content; they don't belong in the explorer.
  expect(res.paths).not.toContain(".worqload-reports");
  expect(res.paths).not.toContain(".worqload-draft");
});

// What the import graph / cycle detection actually computes is import-graph's
// and structure-view's contract — covered by their own tests. Here we only
// check the endpoint wires the diff (for the changeset's files) and the
// worktree's source files into a scoped graph. The fake worktreeOps echoes a
// canned diff so the changed file is observable.
test("GET /sessions/:id/structure returns the changeset's import-dependency neighborhood with cycles flagged", async () => {
  const repoDir = makeTmpDir("repo");
  const cannedDiff = [
    "diff --git a/web/greet.js b/web/greet.js",
    "index 1111111..2222222 100644",
    "--- a/web/greet.js",
    "+++ b/web/greet.js",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: {
      ...fakeWorktreeOps(),
      async gitDiff() {
        return cannedDiff;
      },
    },
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  const wt = created.meta.worktreePath;
  mkdirSync(join(wt, "web"), { recursive: true });
  writeFileSync(join(wt, "web", "app.js"), `import { greet } from "./greet.js";\n`);
  writeFileSync(join(wt, "web", "greet.js"), `import { punctuate } from "./util.js";\n`);
  writeFileSync(join(wt, "web", "util.js"), `import "./app.js";\nexport const punctuate = s => s + "!";\n`);
  writeFileSync(join(wt, "web", "elsewhere.js"), `import "./standalone.js";\n`);
  writeFileSync(join(wt, "web", "standalone.js"), ``);
  writeFileSync(join(wt, "README.md"), `not source\n`);

  const res = await fetch(`${baseUrl}/sessions/${sid}/structure`).then((r) => r.json());
  expect(res.changedFiles).toEqual(["web/greet.js"]);
  // greet.js (changed) and everything within the default hop radius: it imports
  // util.js, which imports app.js, which imports greet.js — a 3-file cycle.
  // elsewhere.js / standalone.js are disconnected; README.md isn't a source file.
  expect(res.graph.nodes).toEqual(["web/app.js", "web/greet.js", "web/util.js"]);
  expect(res.cycles).toEqual([["web/app.js", "web/greet.js", "web/util.js"]]);
});

test("GET /sessions/:id/structure?anchorPath=… re-seeds the graph from the given file and keeps diff-changed nodes highlighted", async () => {
  // The diff only touches greet.js, but the human anchors on the disconnected
  // elsewhere.js. The graph should now be elsewhere.js's neighbourhood
  // (elsewhere → standalone), with anchorPath echoed back and changedFiles
  // empty (greet.js isn't in this slice).
  const repoDir = makeTmpDir("repo");
  const cannedDiff = [
    "diff --git a/web/greet.js b/web/greet.js",
    "index 1111111..2222222 100644",
    "--- a/web/greet.js",
    "+++ b/web/greet.js",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: {
      ...fakeWorktreeOps(),
      async gitDiff() {
        return cannedDiff;
      },
    },
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  const wt = created.meta.worktreePath;
  mkdirSync(join(wt, "web"), { recursive: true });
  writeFileSync(join(wt, "web", "app.js"), `import { greet } from "./greet.js";\n`);
  writeFileSync(join(wt, "web", "greet.js"), `import { punctuate } from "./util.js";\n`);
  writeFileSync(join(wt, "web", "util.js"), `import "./app.js";\n`);
  writeFileSync(join(wt, "web", "elsewhere.js"), `import "./standalone.js";\n`);
  writeFileSync(join(wt, "web", "standalone.js"), ``);

  const res = await fetch(`${baseUrl}/sessions/${sid}/structure?anchorPath=web/elsewhere.js&hops=1`).then((r) =>
    r.json(),
  );
  expect(res.anchorPath).toBe("web/elsewhere.js");
  expect(res.graph.nodes.sort()).toEqual(["web/elsewhere.js", "web/standalone.js"]);
  expect(res.changedFiles).toEqual([]); // greet.js is changed but not in the anchored slice
});

test("GET /sessions/:id/structure with an anchor still tints diff-changed files that land in the anchor neighbourhood", async () => {
  // Anchor on app.js: its neighbourhood pulls in greet.js (which the diff
  // touches), so changedFiles should include greet.js for the blue-tint
  // emphasis, while anchorPath echoes app.js for the anchor emphasis.
  const repoDir = makeTmpDir("repo");
  const cannedDiff = [
    "diff --git a/web/greet.js b/web/greet.js",
    "index 1111111..2222222 100644",
    "--- a/web/greet.js",
    "+++ b/web/greet.js",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: {
      ...fakeWorktreeOps(),
      async gitDiff() {
        return cannedDiff;
      },
    },
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  const wt = created.meta.worktreePath;
  mkdirSync(join(wt, "web"), { recursive: true });
  writeFileSync(join(wt, "web", "app.js"), `import { greet } from "./greet.js";\n`);
  writeFileSync(join(wt, "web", "greet.js"), ``);

  const res = await fetch(`${baseUrl}/sessions/${sid}/structure?anchorPath=web/app.js&hops=1`).then((r) => r.json());
  expect(res.anchorPath).toBe("web/app.js");
  expect(res.graph.nodes.sort()).toEqual(["web/app.js", "web/greet.js"]);
  expect(res.changedFiles).toEqual(["web/greet.js"]);
});

test("GET /sessions/:id/structure?side=before draws the graph from the diff base's tree instead of the worktree", async () => {
  // The diff renames greet.js's import: at the base it imports old.js, at HEAD
  // it imports new.js. With ?side=before we expect the Before graph
  // (greet.js → old.js), not the After graph the default returns.
  const repoDir = makeTmpDir("repo");
  const cannedDiff = [
    "diff --git a/web/greet.js b/web/greet.js",
    "index 1111111..2222222 100644",
    "--- a/web/greet.js",
    "+++ b/web/greet.js",
    "@@ -1 +1 @@",
    '-import "./old.js";',
    '+import "./new.js";',
  ].join("\n");

  const beforeTree: Record<string, string> = {
    "web/greet.js": `import "./old.js";\n`,
    "web/old.js": ``,
  };
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: inProcessHostLauncher(),
    worktreeOps: {
      ...fakeWorktreeOps(),
      async gitDiff() {
        return cannedDiff;
      },
      async listFilesAtRevision() {
        return Object.keys(beforeTree).sort();
      },
      async readFileAtRevision(_wt, _rev, relPath) {
        const content = beforeTree[relPath];
        return content === undefined ? { kind: "not-found" } : { kind: "text", content };
      },
    },
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  const wt = created.meta.worktreePath;
  mkdirSync(join(wt, "web"), { recursive: true });
  writeFileSync(join(wt, "web", "greet.js"), `import "./new.js";\n`);
  writeFileSync(join(wt, "web", "new.js"), ``);

  const after = await fetch(`${baseUrl}/sessions/${sid}/structure`).then((r) => r.json());
  expect(after.side).toBe("after");
  expect(after.graph.nodes.sort()).toEqual(["web/greet.js", "web/new.js"]);

  const before = await fetch(`${baseUrl}/sessions/${sid}/structure?side=before`).then((r) => r.json());
  expect(before.side).toBe("before");
  expect(before.graph.nodes.sort()).toEqual(["web/greet.js", "web/old.js"]);
  expect(before.changedFiles).toEqual(["web/greet.js"]);
});

test("GET /sessions/:id/file returns text content of a worktree file", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "notes.txt"), "alpha\nbeta\n");

  const res = await fetch(`${baseUrl}/sessions/${sid}/file?path=notes.txt`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe("notes.txt");
  expect(body.content).toBe("alpha\nbeta\n");
});

test("GET /sessions/:id/file rejects paths that escape the worktree", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await fetch(`${baseUrl}/sessions/${sid}/file?path=${encodeURIComponent("../".repeat(20) + "etc/hosts")}`);
  expect(res.status).toBe(403);
});

test("GET /sessions/:id/file returns 404 for a missing file and 400 without a path", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  expect((await fetch(`${baseUrl}/sessions/${sid}/file?path=nope.txt`)).status).toBe(404);
  expect((await fetch(`${baseUrl}/sessions/${sid}/file`)).status).toBe(400);
});

test("GET /sessions/:id/file flags binary files instead of returning their bytes", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "blob.bin"), Buffer.from([0x68, 0x69, 0x00, 0x03, 0xff]));

  const body = await fetch(`${baseUrl}/sessions/${sid}/file?path=blob.bin`).then((r) => r.json());
  expect(body.binary).toBe(true);
  expect(body.content).toBeUndefined();
});

test("GET /sessions/:id/search returns matching lines across worktree files; empty query yields no matches", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  const wt = created.meta.worktreePath;
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src", "a.ts"), "const needle = 1;\nplain\n");
  writeFileSync(join(wt, "README.md"), "no match here\n");

  const res = await fetch(`${baseUrl}/sessions/${sid}/search?q=needle`).then((r) => r.json());
  expect(res.matches).toEqual([{ path: "src/a.ts", line: 1, text: "const needle = 1;" }]);
  expect(res.truncated).toBe(false);

  const empty = await fetch(`${baseUrl}/sessions/${sid}/search?q=`).then((r) => r.json());
  expect(empty.matches).toEqual([]);
});

test("GET /sessions/:id/code-nav/definition reports unavailable for a language with no server, and 400 on bad params", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "notes.rb"), "def thing; end\n");

  const res = await fetch(
    `${baseUrl}/sessions/${sid}/code-nav/definition?path=notes.rb&language=ruby&line=0&character=4`,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ available: false });

  expect((await fetch(`${baseUrl}/sessions/${sid}/code-nav/references?path=notes.rb&language=ruby`)).status).toBe(400);
  expect((await fetch(`${baseUrl}/sessions/${sid}/code-nav/definition?line=0&character=0`)).status).toBe(400);
});

// How a git remote URL maps to a web URL is `permalink`'s contract — see
// permalink.test.ts. Here we check the endpoint pulls the remote/HEAD from
// worktreeOps and threads them through, including the branch the link needs.
test("GET /sessions/:id/permalink returns a blob URL at HEAD for a file and line range", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const file = await fetch(`${baseUrl}/sessions/${sid}/permalink?path=src/a.ts`).then((r) => r.json());
  expect(file.url).toBe(`https://github.com/owner/repo/blob/${"f".repeat(40)}/src/a.ts`);
  expect(file.branch).toBe(created.meta.branchName);

  const range = await fetch(`${baseUrl}/sessions/${sid}/permalink?path=src/a.ts&lineStart=3&lineEnd=8`).then((r) =>
    r.json(),
  );
  expect(range.url).toBe(`https://github.com/owner/repo/blob/${"f".repeat(40)}/src/a.ts#L3-L8`);

  expect((await fetch(`${baseUrl}/sessions/${sid}/permalink`)).status).toBe(400);
});

test("GET /sessions/:id/permalink returns null with a reason when the worktree has no remote", async () => {
  const repoDir = makeGitRepo();
  const { baseUrl } = await bootServerRealGit(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await fetch(`${baseUrl}/sessions/${sid}/permalink?path=README.md`).then((r) => r.json());
  expect(res.url).toBeNull();
  expect(res.reason).toBe("no-remote");
});

// How a branch maps to a PR URL is the PrLinkResolver's contract (see
// pr-link.test.ts for the gh result mapping). Here we check the endpoint hands
// the resolver the session's branch + worktree and passes its result through.
test("GET /sessions/:id/pr-link returns the resolver's URL for the session branch", async () => {
  const repoDir = makeTmpDir("repo");
  let seen: { worktreePath: string; branchName: string } | null = null;
  const { baseUrl } = await bootServer(repoDir, {
    prLinkResolver: {
      async resolve(params) {
        seen = params;
        return { url: "https://github.com/owner/repo/pull/7" };
      },
    },
  });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await fetch(`${baseUrl}/sessions/${sid}/pr-link`).then((r) => r.json());
  expect(res.url).toBe("https://github.com/owner/repo/pull/7");
  expect(seen?.branchName).toBe(created.meta.branchName);
  expect(seen?.worktreePath).toBe(created.meta.worktreePath);
});

test("GET /sessions/:id/pr-link passes through the no-PR reason", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir, {
    prLinkResolver: {
      async resolve() {
        return { url: null, reason: "no-pr" };
      },
    },
  });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const res = await fetch(`${baseUrl}/sessions/${created.meta.id}/pr-link`).then((r) => r.json());
  expect(res.url).toBeNull();
  expect(res.reason).toBe("no-pr");
});

// The sidebar prefetches every session's PR link off its poll; without server
// caching that would respawn the resolver per session per poll. Two reads of
// the same session hit the resolver once.
test("GET /sessions/:id/pr-link caches the resolver result across requests", async () => {
  const repoDir = makeTmpDir("repo");
  let calls = 0;
  const { baseUrl } = await bootServer(repoDir, {
    prLinkResolver: {
      async resolve() {
        calls++;
        return { url: "https://github.com/owner/repo/pull/9" };
      },
    },
  });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await fetch(`${baseUrl}/sessions/${sid}/pr-link`).then((r) => r.json());
  const second = await fetch(`${baseUrl}/sessions/${sid}/pr-link`).then((r) => r.json());
  expect(second.url).toBe("https://github.com/owner/repo/pull/9");
  expect(calls).toBe(1);

  const fresh = await fetch(`${baseUrl}/sessions/${sid}/pr-link?fresh=1`).then((r) => r.json());
  expect(fresh.url).toBe("https://github.com/owner/repo/pull/9");
  expect(calls).toBe(2);
});

test("GET /sessions/:id/asking returns pending escalations", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/escalations`, { slug: "lib", content: "X or Y?" });

  const res = await fetch(`${baseUrl}/sessions/${sid}/asking`).then((r) => r.json());
  expect(res.asking).toHaveLength(1);
  expect(res.asking[0].content).toBe("X or Y?");
});

test("POST /sessions/:id/title sets, updates and clears the display title", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", {
    prompt: "あなたに長いお願いごとをしたいです、これはサイドバーで読みにくい",
    baseBranch: TEST_BASE,
  }).then((r) => r.json());
  const sid = created.meta.id;
  expect(created.meta.title).toBeUndefined();

  // set
  const set = await postJson(baseUrl, `/sessions/${sid}/title`, { title: "  リファクタ祭り  " }).then((r) => r.json());
  expect(set.meta.title).toBe("リファクタ祭り");
  expect((await loadSessionMeta(sid, ctx.sessionsDir))?.title).toBe("リファクタ祭り");
  expect((await fetch(`${baseUrl}/sessions/${sid}`).then((r) => r.json())).meta.title).toBe("リファクタ祭り");

  // update
  const updated = await postJson(baseUrl, `/sessions/${sid}/title`, { title: "別名" }).then((r) => r.json());
  expect(updated.meta.title).toBe("別名");

  // clear (empty / whitespace → drop the field, fall back to the prompt)
  const cleared = await postJson(baseUrl, `/sessions/${sid}/title`, { title: "   " }).then((r) => r.json());
  expect(cleared.meta.title).toBeUndefined();
  expect((await loadSessionMeta(sid, ctx.sessionsDir))?.title).toBeUndefined();

  // surfaced in the session list too
  const list = await fetch(`${baseUrl}/sessions`).then((r) => r.json());
  expect(list.sessions.find((s: { id: string }) => s.id === sid)?.title).toBeUndefined();
});

test("POST /sessions/:id/title rejects a non-string title and an unknown session", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  expect((await postJson(baseUrl, `/sessions/${created.meta.id}/title`, { title: 123 })).status).toBe(400);
  expect((await postJson(baseUrl, `/sessions/${created.meta.id}/title`, {})).status).toBe(400);
  expect((await postJson(baseUrl, "/sessions/nope/title", { title: "x" })).status).toBe(404);
});

test("POST /sessions/:id/archive hides terminal sessions from default list", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  // Cannot archive while running
  const tooEarly = await fetch(`${baseUrl}/sessions/${sid}/archive`, { method: "POST" });
  expect(tooEarly.status).toBe(400);

  await postJson(baseUrl, `/sessions/${sid}/stop`, {});
  const archived = await postJson(baseUrl, `/sessions/${sid}/archive`, {}).then((r) => r.json());
  expect(archived.meta.archivedAt).toBeDefined();

  const visible = await fetch(`${baseUrl}/sessions`).then((r) => r.json());
  expect(visible.sessions.find((s: { id: string }) => s.id === sid)).toBeUndefined();

  const all = await fetch(`${baseUrl}/sessions?includeArchived=true`).then((r) => r.json());
  expect(all.sessions.find((s: { id: string }) => s.id === sid)).toBeDefined();
});

// Plants the per-session preview pidfile that `isSessionPreviewAlive` reads,
// pointed at a live process so the archive guard sees a running preview. The
// pidfile path mirrors `previewPaths()` in src/actions.ts; we only write the
// pidfile itself (no log) so the URL field on the 409 response is null.
function plantLivePreviewPid(root: string, sessionId: string, pid: number): void {
  const shortId = sessionId.slice(0, 8);
  const dir = join(root, shortId, ".worqload");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "preview.pid"), String(pid));
}

test("POST /sessions/:id/archive refuses with 409 when a preview is still running", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);
  const previewRoot = makeTmpDir("preview-root");
  process.env.WORQLOAD_PREVIEW_DIR = previewRoot;
  try {
    const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
    const sid = created.meta.id;
    await postJson(baseUrl, `/sessions/${sid}/stop`, {});
    plantLivePreviewPid(previewRoot, sid, process.pid);

    const res = await fetch(`${baseUrl}/sessions/${sid}/archive`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("preview-running");
    expect(body.pid).toBe(process.pid);

    // The session must not have been marked archived by the refused request.
    const all = await fetch(`${baseUrl}/sessions?includeArchived=true`).then((r) => r.json());
    const found = all.sessions.find((s: { id: string; archivedAt?: string }) => s.id === sid);
    expect(found?.archivedAt).toBeUndefined();
  } finally {
    delete process.env.WORQLOAD_PREVIEW_DIR;
  }
});

test("POST /sessions/:id/archive?stopPreview=true stops the preview then archives", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);
  const previewRoot = makeTmpDir("preview-root");
  process.env.WORQLOAD_PREVIEW_DIR = previewRoot;

  // Spawn a real child we control so the archive flow can SIGTERM it. `sleep`
  // exits on SIGTERM with a non-zero status, which is what we want — we only
  // need it alive long enough to be killed.
  const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
    const sid = created.meta.id;
    await postJson(baseUrl, `/sessions/${sid}/stop`, {});
    plantLivePreviewPid(previewRoot, sid, proc.pid as number);

    const res = await fetch(`${baseUrl}/sessions/${sid}/archive?stopPreview=true`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.archivedAt).toBeDefined();

    // The preview child must have been signalled — proc.exited resolves once
    // the SIGTERM the archive flow sent lands.
    await proc.exited;
  } finally {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    delete process.env.WORQLOAD_PREVIEW_DIR;
  }
});

test("GET /sessions?archived=only returns only archived sessions", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const active = await postJson(baseUrl, "/sessions", { prompt: "active", baseBranch: TEST_BASE }).then((r) =>
    r.json(),
  );
  const toArchive = await postJson(baseUrl, "/sessions", { prompt: "to-archive", baseBranch: TEST_BASE }).then((r) =>
    r.json(),
  );

  await postJson(baseUrl, `/sessions/${toArchive.meta.id}/stop`, {});
  await postJson(baseUrl, `/sessions/${toArchive.meta.id}/archive`, {});

  const onlyArchived = await fetch(`${baseUrl}/sessions?archived=only`).then((r) => r.json());
  const ids = onlyArchived.sessions.map((s: { id: string }) => s.id);
  expect(ids).toContain(toArchive.meta.id);
  expect(ids).not.toContain(active.meta.id);
});

test("POST /sessions/:id/unarchive clears archivedAt and the session reappears in the default list", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "rescue-me", baseBranch: TEST_BASE }).then((r) =>
    r.json(),
  );
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/stop`, {});
  await postJson(baseUrl, `/sessions/${sid}/archive`, {});

  const hidden = await fetch(`${baseUrl}/sessions`).then((r) => r.json());
  expect(hidden.sessions.find((s: { id: string }) => s.id === sid)).toBeUndefined();

  const restored = await postJson(baseUrl, `/sessions/${sid}/unarchive`, {}).then((r) => r.json());
  expect(restored.meta.archivedAt).toBeUndefined();

  const visible = await fetch(`${baseUrl}/sessions`).then((r) => r.json());
  expect(visible.sessions.find((s: { id: string }) => s.id === sid)).toBeDefined();

  const onlyArchived = await fetch(`${baseUrl}/sessions?archived=only`).then((r) => r.json());
  expect(onlyArchived.sessions.find((s: { id: string }) => s.id === sid)).toBeUndefined();
});

test("POST /sessions/:id/unarchive on a non-archived session is a no-op (200)", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "active", baseBranch: TEST_BASE }).then((r) =>
    r.json(),
  );
  const sid = created.meta.id;

  const res = await postJson(baseUrl, `/sessions/${sid}/unarchive`, {});
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.meta.archivedAt).toBeUndefined();
});

test("POST /sessions/:id/unarchive returns 404 for an unknown id", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const res = await postJson(baseUrl, "/sessions/nope/unarchive", {});
  expect(res.status).toBe(404);
});

test("DELETE /sessions/:id removes worktree, branch, and session dir for an archived session", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "delete-me", baseBranch: TEST_BASE }).then((r) =>
    r.json(),
  );
  const sid = created.meta.id;
  const worktreePath = created.meta.worktreePath;
  const sessionDir = join(ctx.sessionsDir, sid);

  expect(existsSync(worktreePath)).toBe(true);
  expect(existsSync(sessionDir)).toBe(true);

  await postJson(baseUrl, `/sessions/${sid}/stop`, {});
  await postJson(baseUrl, `/sessions/${sid}/archive`, {});

  const res = await fetch(`${baseUrl}/sessions/${sid}`, { method: "DELETE" });
  expect(res.status).toBe(200);

  expect(existsSync(worktreePath)).toBe(false);
  expect(existsSync(sessionDir)).toBe(false);

  const all = await fetch(`${baseUrl}/sessions?includeArchived=true`).then((r) => r.json());
  expect(all.sessions.find((s: { id: string }) => s.id === sid)).toBeUndefined();
});

test("DELETE /sessions/:id refuses to delete a non-archived session", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "still-active", baseBranch: TEST_BASE }).then((r) =>
    r.json(),
  );
  const sid = created.meta.id;

  const res = await fetch(`${baseUrl}/sessions/${sid}`, { method: "DELETE" });
  expect(res.status).toBe(400);

  expect(existsSync(join(ctx.sessionsDir, sid))).toBe(true);
});

test("DELETE /sessions/:id returns 404 for an unknown id", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const res = await fetch(`${baseUrl}/sessions/nope`, { method: "DELETE" });
  expect(res.status).toBe(404);
});

test("GET /sessions/:id/feedback merges inbox and read with status", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "first", slug: "a" });
  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "second", slug: "b" });
  // drain only the first one by simulating an agent fetch
  await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  // post a third one after fetch
  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "third", slug: "c" });

  const history = await fetch(`${baseUrl}/sessions/${sid}/feedback`).then((r) => r.json());
  expect(history.messages).toHaveLength(3);
  // newest (highest serial) first
  expect(history.messages.map((m: { content: string }) => m.content)).toEqual(["third", "second", "first"]);
  // first two were drained (status read), third is unread
  const byContent = Object.fromEntries(
    history.messages.map((m: { content: string; status: string }) => [m.content, m.status]),
  );
  expect(byContent["first"]).toBe("read");
  expect(byContent["second"]).toBe("read");
  expect(byContent["third"]).toBe("unread");
});

test("GET /sessions/:id/feedback exposes the structured anchor and keeps the body clean", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "plain", slug: "feedback" });
  await postJson(baseUrl, `/sessions/${sid}/feedback`, {
    content: "look at these lines",
    slug: "anchored",
    anchor: { path: "src/foo.ts", lineStart: 10, lineEnd: 12 },
  });

  const history = await fetch(`${baseUrl}/sessions/${sid}/feedback`).then((r) => r.json());
  const anchored = history.messages.find((m: { content: string }) => m.content === "look at these lines");
  expect(anchored.anchor).toEqual({ path: "src/foo.ts", lineStart: 10, lineEnd: 12 });
  const plain = history.messages.find((m: { content: string }) => m.content === "plain");
  expect(plain.anchor).toBeUndefined();
});

test("startServer reconnects to a still-running host across a serve restart", async () => {
  const repoDir = makeGitRepo();
  const first = await startServer({
    port: 0,
    repoDir,
    spawnCommand: ["bun", MOCK, "hang"],
    branchNameGenerator: async () => null,
    hostCommand: HOST_COMMAND,
  });
  const baseUrl1 = `http://127.0.0.1:${first.server.port}`;
  const created = await postJson(baseUrl1, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
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

  const detail = await fetch(`${baseUrl2}/sessions/${sid}`).then((r) => r.json());
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
  await new Promise((r) => setTimeout(r, 100));
  let alive = true;
  try {
    process.kill(hostPid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
});

test("startServer marks a session crashed when its host is dead on boot", async () => {
  const repoDir = makeGitRepo();
  const first = await startServer({
    port: 0,
    repoDir,
    spawnCommand: ["bun", MOCK, "hang"],
    branchNameGenerator: async () => null,
    hostCommand: HOST_COMMAND,
  });
  const baseUrl1 = `http://127.0.0.1:${first.server.port}`;
  const created = await postJson(baseUrl1, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
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

  const detail = await fetch(`${baseUrl2}/sessions/${sid}`).then((r) => r.json());
  expect(detail.meta.status).toBe("crashed");
  expect(detail.meta.endedAt).toBeDefined();
  expect(detail.events.some((e: { kind: string }) => e.kind === "session_crashed")).toBe(true);
});

test("WS /sessions/:id/stream replays past events on subscribe and pushes live ones", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/sessions/${sid}/stream`);
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));

  const messages: { sessionId: string; event: { kind: string; seq: number } }[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(JSON.parse(typeof e.data === "string" ? e.data : ""));
  });

  ws.send(JSON.stringify({ type: "subscribe", lastSeq: 0 }));
  // wait for replay
  await new Promise((r) => setTimeout(r, 100));
  expect(messages.some((m) => m.event.kind === "session_started")).toBe(true);

  // Now trigger a new server-side event and confirm it streams to the client.
  const messageCountBefore = messages.length;
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "live", content: "live event body" });
  await new Promise((r) => setTimeout(r, 100));

  expect(messages.length).toBeGreaterThan(messageCountBefore);
  expect(messages.some((m) => m.event.kind === "report_submitted")).toBe(true);

  ws.close();
  await new Promise((r) => setTimeout(r, 30));
});

test("POST /sessions/:id/cancel no longer exists", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const res = await postJson(baseUrl, `/sessions/${created.meta.id}/cancel`, {});
  expect(res.status).toBe(404);
});

test("POST /sessions/:id/resume respawns the host and returns the session to running", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/stop`, {});
  expect(ctx.clients.has(sid)).toBe(false);
  let meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("stopped");
  expect(meta?.endedAt).toBeDefined();

  const resumed = await postJson(baseUrl, `/sessions/${sid}/resume`, {}).then((r) => r.json());
  expect(resumed.meta.status).toBe("running");
  expect(resumed.meta.endedAt).toBeUndefined();
  expect(ctx.clients.has(sid)).toBe(true);

  meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("running");
  expect(meta?.endedAt).toBeUndefined();
});

// Regression: Stop&Resume is two sequential POSTs. postStop kills the old
// host and drops ctx.clients[sid]; the old host's unix socket then tears down
// a beat LATER (it sends `exited`, sleeps ~20ms, stops its listener). By then
// postResume has already attached the NEW host and set ctx.clients[sid]. The
// old client's onDisconnect — which used to `ctx.clients.delete(sid)`
// unconditionally — would evict the freshly-attached new host, leaving the
// session "running" with no client. Every later feedback then logged
// hasClient:false and the agent never woke. onDisconnect must identity-check.
test("a stopped host's late socket teardown does not evict the resumed attachment", async () => {
  const repoDir = makeTmpDir("repo");
  const launches: { resume: boolean; onDisconnect: () => void }[] = [];
  const captureLauncher: HostLauncher = async ({ meta, sessionsDir, resume, onEvent, onDisconnect }) => {
    const event = await appendEvent(
      meta.id,
      { kind: resume ? "session_resumed" : "session_started", payload: { prompt: meta.prompt } },
      sessionsDir,
    );
    onEvent(event);
    let resolveExited!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolveExited = r;
    });
    launches.push({ resume, onDisconnect });
    return {
      client: {
        async send() {},
        async kill() {
          resolveExited(null);
        },
        async close() {
          resolveExited(null);
        },
        replayCompleted: Promise.resolve({ lastSeq: event.seq }),
        exited,
      },
    };
  };
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: captureLauncher,
    worktreeOps: fakeWorktreeOps(),
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;
  const ctx = started.ctx;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  expect(launches).toHaveLength(1);

  await postJson(baseUrl, `/sessions/${sid}/stop`, {});
  await postJson(baseUrl, `/sessions/${sid}/resume`, {});
  expect(launches).toHaveLength(2);
  expect(ctx.clients.has(sid)).toBe(true);

  // The original (stopped) host's socket finally tears down — its onDisconnect
  // fires now, AFTER the resumed host already attached.
  launches[0].onDisconnect();

  expect(ctx.clients.has(sid)).toBe(true);

  // Feedback reaches the resumed host (hasClient:true), and because the client
  // is present no extra respawn fires.
  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "ping", slug: "f" });
  expect(launches).toHaveLength(2);
  const logLines = readFileSync(hostLogPath(ctx.sessionsDir, sid), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const wakes = logLines.filter((l) => l.event === "wake_sent");
  expect(wakes.at(-1)?.hasClient).toBe(true);
});

test("POST /sessions/:id/resume queues the optional prompt as feedback", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  await postJson(baseUrl, `/sessions/${sid}/stop`, {});

  await postJson(baseUrl, `/sessions/${sid}/resume`, { prompt: "now do the other thing" });

  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  const files = readdirSync(inboxDir);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/-resume\.md$/);
  expect(readFileSync(join(inboxDir, files[0]), "utf8")).toContain("now do the other thing");
});

test("POST /sessions/:id/resume rejects a session that is still running", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await postJson(baseUrl, `/sessions/${sid}/resume`, {});
  expect(res.status).toBe(400);
});

test("POST /sessions/:id/resume rejects a session whose worktree is gone", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  await postJson(baseUrl, `/sessions/${sid}/stop`, {});
  rmSync(created.meta.worktreePath, { recursive: true, force: true });

  const res = await postJson(baseUrl, `/sessions/${sid}/resume`, {});
  expect(res.status).toBe(400);
});

test("GET / serves the built HTML shell referencing the hashed /assets bundles", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const res = await fetch(`${baseUrl}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const body = await res.text();
  expect(body).toMatch(/<script[^>]+src="\/assets\/[^"]+\.js"/);
  expect(body).toMatch(/<link[^>]+href="\/assets\/[^"]+\.css"/);
});

test("the /assets bundles referenced by index.html are all reachable", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const html = await (await fetch(`${baseUrl}/`)).text();
  const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  expect(refs.length).toBeGreaterThan(0);
  const statuses = Object.fromEntries(
    await Promise.all(refs.map(async (ref) => [ref, (await fetch(`${baseUrl}${ref}`)).status] as const)),
  );
  expect(statuses).toEqual(Object.fromEntries(refs.map((ref) => [ref, 200])));
});

test("GET /assets/<unknown> returns 404", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const res = await fetch(`${baseUrl}/assets/nope.js`);
  expect(res.status).toBe(404);
});

test("GET /actions exposes the built-in action registry", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const res = await fetch(`${baseUrl}/actions`).then((r) => r.json());
  const ids = res.actions.map((a: { id: string }) => a.id);
  expect(ids).toContain("merge-to-base");
  expect(ids).toContain("create-pr");
});

test("POST /sessions/:id/actions/:actionId returns 404 for unknown action", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);
  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await postJson(baseUrl, `/sessions/${sid}/actions/nope`, {});
  expect(res.status).toBe(404);
});

test("POST /sessions/:id/actions/merge-to-base merges when preconditions hold", async () => {
  const repoDir = makeGitRepo();
  const { baseUrl } = await bootServerRealGit(repoDir);
  const created = await postJson(baseUrl, "/sessions", { prompt: "merge me", baseBranch: TEST_BASE }).then((r) =>
    r.json(),
  );
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
  const repoDir = makeGitRepo();
  const { baseUrl } = await bootServerRealGit(repoDir);
  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
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
  const repoDir = makeGitRepo();
  const { baseUrl, ctx } = await bootServerRealGit(repoDir);
  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  // dirty the main repo so merge-to-base fails predictably; we only care that
  // the attempt (failure included) is recorded.
  writeFileSync(join(repoDir, "scratch.txt"), "dirt\n");
  Bun.spawnSync(["git", "add", "scratch.txt"], { cwd: repoDir, env: cleanGitEnv });
  await postJson(baseUrl, `/sessions/${sid}/actions/merge-to-base`, {});

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  const invoked = events.filter((e) => e.kind === "action_invoked");
  expect(invoked.length).toBe(1);
  const payload = invoked[0].payload as { actionId: string; ok: boolean };
  expect(payload.actionId).toBe("merge-to-base");
  expect(payload.ok).toBe(false);
});

test("command approval: request creates asking + sidecar, sets waiting_human, getAsking exposes the command", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const dangerousCommand = "npm publish --access public";
  const req = await postJson(baseUrl, `/internal/sessions/${sid}/command-approvals`, {
    command: dangerousCommand,
    reason: "release the package",
  }).then((r) => r.json());
  expect(req.filename).toBe("001-command-approval.md");

  const askingDir = join(ctx.sessionsDir, sid, "asking");
  expect(readdirSync(askingDir).sort()).toEqual(["001-command-approval.command.json", "001-command-approval.md"]);
  expect(JSON.parse(readFileSync(join(askingDir, "001-command-approval.command.json"), "utf8")).command).toBe(
    dangerousCommand,
  );

  const meta = await loadSessionMeta(sid, ctx.sessionsDir);
  expect(meta?.status).toBe("waiting_human");

  const asking = await fetch(`${baseUrl}/sessions/${sid}/asking`).then((r) => r.json());
  expect(asking.asking).toHaveLength(1);
  expect(asking.asking[0].command).toBe(dangerousCommand);
  expect(asking.asking[0].content).toContain("REQUIRE APPROVAL");
});

test("command approval: approve runs the command in the worktree and feeds back its output", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/command-approvals`, { command: "echo approved-ok" });

  const resolved = await postJson(baseUrl, `/sessions/${sid}/escalations/001-command-approval.md/resolve`, {
    decision: "approve",
  }).then((r) => r.json());
  expect(resolved.ok).toBe(true);
  expect(resolved.exitCode).toBe(0);
  expect(resolved.stdout).toContain("approved-ok");

  const askingDir = join(ctx.sessionsDir, sid, "asking");
  expect(readdirSync(askingDir).filter((f) => f.endsWith(".md") || f.endsWith(".json"))).toEqual([]);
  expect(readdirSync(join(askingDir, "resolved")).sort()).toEqual([
    "001-command-approval.command.json",
    "001-command-approval.md",
  ]);

  const detail = await fetch(`${baseUrl}/sessions/${sid}`).then((r) => r.json());
  expect(detail.meta.status).toBe("running");

  const inbox = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  expect(inbox.messages).toHaveLength(1);
  expect(inbox.messages[0].content).toContain("approved this command");
  expect(inbox.messages[0].content).toContain("approved-ok");
  expect(inbox.messages[0].content).toContain("Exit code");

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  const resolvedEvent = events.find((e) => e.kind === "escalation_resolved");
  const resolvedPayload = resolvedEvent?.payload as { decision?: string; exitCode?: number; stdout?: string };
  expect(resolvedPayload?.decision).toBe("approve");
  expect(resolvedPayload?.exitCode).toBe(0);
  expect(resolvedPayload?.stdout).toContain("approved-ok");
});

test("command approval: approve with a human note relays that note in the feedback to the agent", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/command-approvals`, { command: "echo approved-ok" });

  const note = "use the output but truncate to the first line only";
  const resolved = await postJson(baseUrl, `/sessions/${sid}/escalations/001-command-approval.md/resolve`, {
    decision: "approve",
    content: note,
  }).then((r) => r.json());
  expect(resolved.ok).toBe(true);

  const inbox = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  expect(inbox.messages).toHaveLength(1);
  expect(inbox.messages[0].content).toContain("approved this command");
  expect(inbox.messages[0].content).toContain(note);

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  const resolvedEvent = events.find((e) => e.kind === "escalation_resolved");
  const resolvedPayload = resolvedEvent?.payload as { decision?: string; note?: string };
  expect(resolvedPayload?.decision).toBe("approve");
  expect(resolvedPayload?.note).toBe(note);
});

test("command approval: reject does not run the command and feeds back the rejection", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const marker = join(repoDir, "should-not-exist");
  await postJson(baseUrl, `/internal/sessions/${sid}/command-approvals`, {
    command: `touch ${JSON.stringify(marker)}`,
  });

  const resolved = await postJson(baseUrl, `/sessions/${sid}/escalations/001-command-approval.md/resolve`, {
    decision: "reject",
    content: "we never touch that path",
  }).then((r) => r.json());
  expect(resolved.ok).toBe(true);
  expect(existsSync(marker)).toBe(false);

  const inbox = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  expect(inbox.messages[0].content).toContain("rejected this command");
  expect(inbox.messages[0].content).toContain("we never touch that path");
});

test("command approval: resolve without a decision is rejected", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/command-approvals`, { command: "echo hi" });
  const res = await postJson(baseUrl, `/sessions/${sid}/escalations/001-command-approval.md/resolve`, {
    content: "yes please",
  });
  expect(res.status).toBe(400);
});

test("GET /favicon serves the built-in default icon when no custom favicon is configured", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const res = await fetch(`${baseUrl}/favicon`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("image/svg+xml");
  expect(await res.text()).toContain("<svg");
});

test("GET /favicon serves a custom favicon dropped at .worqload/favicon.*", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(join(repoDir, ".worqload", "favicon.png"), pngBytes);

  const res = await fetch(`${baseUrl}/favicon`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("image/png");
  expect(Buffer.from(await res.arrayBuffer())).toEqual(pngBytes);
});

test("GET / links the favicon route in the document head", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const html = await fetch(`${baseUrl}/`).then((r) => r.text());
  expect(html).toMatch(/<link[^>]+rel="icon"[^>]+href="\/favicon"/);
});
