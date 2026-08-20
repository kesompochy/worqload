import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { appendEvent, readEvents } from "./event-log";
import { agentEndpointPath, hostLogPath, loadSessionMeta, saveSessionMeta } from "./session";
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
    // Keep tests off the developer's real ~/.config/worqload/config.yaml; a
    // missing path means no textlint rules unless a test injects its own.
    configPath: join(repoDir, "no-such-worqload-config.yaml"),
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

test("GET /meta returns the repo directory, its basename, and the driver name", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir, { driverName: "tmux" });

  const res = await fetch(`${baseUrl}/meta`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.repoDir).toBe(repoDir);
  expect(body.repoName).toBe(repoDir.split("/").pop());
  expect(body.driverName).toBe("tmux");
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

test("POST /sessions with startPaused creates a stopped session without spawning a host", async () => {
  const repoDir = makeTmpDir("repo");
  let hostLauncherCalled = false;
  const trackingLauncher: HostLauncher = async (req) => {
    hostLauncherCalled = true;
    return inProcessHostLauncher()(req);
  };
  const started = await startServer({
    port: 0,
    repoDir,
    branchNameGenerator: async () => null,
    hostLauncher: trackingLauncher,
    worktreeOps: fakeWorktreeOps(),
    configPath: join(repoDir, "no-such-worqload-config.yaml"),
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;

  const res = await postJson(baseUrl, "/sessions", {
    prompt: "do thing",
    baseBranch: TEST_BASE,
    startPaused: true,
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.meta.status).toBe("stopped");
  expect(hostLauncherCalled).toBe(false);
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

test("DELETE /sessions/:id/reports/:filename removes the report and emits report_deleted", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "keep", content: "keep me" });
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "drop", content: "misplaced" });

  const res = await fetch(`${baseUrl}/sessions/${sid}/reports/002-drop.md`, { method: "DELETE" });
  expect(res.status).toBe(200);

  const reportsDir = join(ctx.sessionsDir, sid, "reports");
  expect(readdirSync(reportsDir).filter((f) => f.endsWith(".md"))).toEqual(["001-keep.md"]);

  const remaining = await fetch(`${baseUrl}/sessions/${sid}/reports`).then((r) => r.json());
  expect(remaining.reports.map((r: { filename: string }) => r.filename)).toEqual(["001-keep.md"]);

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.filter((e) => e.kind === "report_deleted")).toHaveLength(1);
});

test("DELETE /sessions/:id/reports/:filename 404s for an unknown report", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await fetch(`${baseUrl}/sessions/${sid}/reports/999-nope.md`, { method: "DELETE" });
  expect(res.status).toBe(404);
});

test("DELETE /sessions/:id/feedback/:filename removes feedback from inbox and emits feedback_deleted", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "keep", slug: "keep" });
  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "drop", slug: "drop" });

  const res = await fetch(`${baseUrl}/sessions/${sid}/feedback/002-drop.md`, { method: "DELETE" });
  expect(res.status).toBe(200);

  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  expect(readdirSync(inboxDir).filter((f) => f.endsWith(".md"))).toEqual(["001-keep.md"]);

  const remaining = await fetch(`${baseUrl}/sessions/${sid}/feedback`).then((r) => r.json());
  expect(remaining.messages.map((m: { filename: string }) => m.filename)).toEqual(["001-keep.md"]);

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.filter((e) => e.kind === "feedback_deleted")).toHaveLength(1);
});

test("DELETE /sessions/:id/feedback/:filename removes feedback from read dir", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "will read", slug: "readit" });
  // Agent fetches → moves inbox to read
  await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`);

  const res = await fetch(`${baseUrl}/sessions/${sid}/feedback/001-readit.md`, { method: "DELETE" });
  expect(res.status).toBe(200);

  const readDir = join(ctx.sessionsDir, sid, "feedback", "read");
  expect(readdirSync(readDir).filter((f) => f.endsWith(".md"))).toEqual([]);
});

test("DELETE /sessions/:id/feedback/:filename 404s for an unknown feedback", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await fetch(`${baseUrl}/sessions/${sid}/feedback/999-nope.md`, { method: "DELETE" });
  expect(res.status).toBe(404);
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

test("GET /sessions/:id/reports exposes each report's submitted time from its report_submitted event", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "the plan" });
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "step", content: "step done" });

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  const submittedAt = Object.fromEntries(
    events
      .filter((e) => e.kind === "report_submitted")
      .map((e) => [(e.payload as { filename: string }).filename, e.timestamp]),
  );

  const body = await fetch(`${baseUrl}/sessions/${sid}/reports`).then((r) => r.json());
  for (const r of body.reports as { filename: string; submittedAt: string }[]) {
    expect(r.submittedAt).toBe(submittedAt[r.filename]);
  }
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

test("a submitted report is stored on first submission with revise mode OFF (the default)", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const r = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "なまの本文" }).then(
    (r) => r.json(),
  );
  expect(r.filename).toBe("001-plan.md");
  const stored = readFileSync(join(ctx.sessionsDir, sid, "reports", r.filename), "utf8");
  expect(stored).toBe("なまの本文");
});

test("with revise mode on, the first submission is bounced for revision and the resubmission is stored verbatim", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  const wt = created.meta.worktreePath;
  await postJson(baseUrl, `/sessions/${sid}/revise-mode`, { enabled: true });

  // First submission: held, not stored.
  const first = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "初稿" });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ revisionRequested: true });
  const reportsDir = join(ctx.sessionsDir, sid, "reports");
  expect(existsSync(reportsDir) && readdirSync(reportsDir).length > 0).toBe(false);

  // The first submission is saved to the worktree scratch file for the session to edit in place.
  expect(readFileSync(join(wt, ".worqload-draft", "revision-draft.md"), "utf8")).toBe("初稿");

  // A revise instruction is queued into the feedback inbox (pointing at the draft) so the session is woken.
  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  const inboxFiles = readdirSync(inboxDir).filter((f) => f.endsWith(".md"));
  expect(inboxFiles).toHaveLength(1);
  expect(readFileSync(join(inboxDir, inboxFiles[0]), "utf8")).toContain(".worqload-draft/revision-draft.md");
  const events = await readEvents(sid, 1, ctx.sessionsDir);
  expect(events.filter((e) => e.kind === "feedback_received")).toHaveLength(1);
  expect(events.filter((e) => e.kind === "report_submitted")).toHaveLength(0);
  const log = readFileSync(hostLogPath(ctx.sessionsDir, sid), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(log.some((e) => e.event === "wake_sent" && e.reason === "report_revision_requested")).toBe(true);

  // Second submission: stored as written, with no further rewrite.
  const second = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "推敲した本文" }).then(
    (r) => r.json(),
  );
  expect(second.filename).toBe("001-plan.md");
  expect(readFileSync(join(ctx.sessionsDir, sid, "reports", second.filename), "utf8")).toBe("推敲した本文");
});

test("the revise-mode cycle resets per report: every report's first submission is bounced", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  await postJson(baseUrl, `/sessions/${sid}/revise-mode`, { enabled: true });

  // Report A: bounce then store.
  expect(await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "a", content: "A初稿" }).then((r) => r.json())).toEqual({ revisionRequested: true });
  const a = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "a", content: "A推敲" }).then((r) => r.json());
  expect(a.filename).toBe("001-a.md");

  // Report B: the next first submission is bounced again, not passed through.
  expect(await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "b", content: "B初稿" }).then((r) => r.json())).toEqual({ revisionRequested: true });
  const b = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "b", content: "B推敲" }).then((r) => r.json());
  expect(b.filename).toBe("002-b.md");
  expect(readFileSync(join(ctx.sessionsDir, sid, "reports", b.filename), "utf8")).toBe("B推敲");
});

test("turning revise mode off mid-cycle clears the pending bounce so the next report stores on first submission", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const on = await postJson(baseUrl, `/sessions/${sid}/revise-mode`, { enabled: true }).then((r) => r.json());
  expect(on.meta.reviseModeEnabled).toBe(true);

  // Bounce the first submission, leaving a pending revision.
  expect(await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "初稿" }).then((r) => r.json())).toEqual({ revisionRequested: true });

  // Toggle off: the pending flag is reset.
  const off = await postJson(baseUrl, `/sessions/${sid}/revise-mode`, { enabled: false }).then((r) => r.json());
  expect(off.meta.reviseModeEnabled).toBe(false);
  expect(off.meta.revisionPending).toBeUndefined();

  // The next report stores on its first submission.
  const r = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "そのまま保存" }).then((r) => r.json());
  expect(r.filename).toBe("001-p.md");
  expect(readFileSync(join(ctx.sessionsDir, sid, "reports", r.filename), "utf8")).toBe("そのまま保存");
});

test("POST /sessions/:id/revise-mode rejects a non-boolean enabled", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);
  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const res = await postJson(baseUrl, `/sessions/${created.meta.id}/revise-mode`, { enabled: "yes" });
  expect(res.status).toBe(400);
});

function writeTextlintConfig(rules: Array<{ string: string; comment: string }>): string {
  const dir = makeTmpDir("worqload-config");
  const configPath = join(dir, "config.yaml");
  const body = "textlint:\n" + rules.map((r) => `  - string: ${JSON.stringify(r.string)}\n    comment: ${JSON.stringify(r.comment)}\n`).join("");
  writeFileSync(configPath, body);
  return configPath;
}

test("revise mode bounces a submission whose forbidden string trips textlint, returning the rule's comment", async () => {
  const repoDir = makeTmpDir("repo");
  const configPath = writeTextlintConfig([{ string: "可能性", comment: "統計的事実のときだけ使う" }]);
  const { baseUrl, ctx } = await bootServer(repoDir, { configPath });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  await postJson(baseUrl, `/sessions/${sid}/revise-mode`, { enabled: true });

  // Clean first submission: held for the ordinary one-shot revision pass.
  expect(await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "初稿" }).then((r) => r.json())).toEqual({ revisionRequested: true });

  // Resubmission trips textlint: bounced again, not stored, comment delivered.
  expect(await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "可能性がある" }).then((r) => r.json())).toEqual({ revisionRequested: true });
  const reportsDir = join(ctx.sessionsDir, sid, "reports");
  expect(existsSync(reportsDir) && readdirSync(reportsDir).length > 0).toBe(false);
  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  const latest = readdirSync(inboxDir).filter((f) => f.endsWith(".md")).sort().at(-1) as string;
  expect(readFileSync(join(inboxDir, latest), "utf8")).toContain("統計的事実のときだけ使う");

  // A clean resubmission stores.
  const stored = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "見込みがある" }).then((r) => r.json());
  expect(stored.filename).toBe("001-p.md");
});

test("revise mode bounces a submission where a rule word appears only in an inflected form", async () => {
  const repoDir = makeTmpDir("repo");
  const configPath = writeTextlintConfig([{ string: "寄せる", comment: "既存実装に揃える意味では使わない" }]);
  const { baseUrl, ctx } = await bootServer(repoDir, { configPath });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  await postJson(baseUrl, `/sessions/${sid}/revise-mode`, { enabled: true });

  // Clean first submission: held for the ordinary one-shot revision pass.
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "初稿" });

  // 「寄せたい」 contains no literal 「寄せる」; only the morphological pass catches it.
  expect(await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "挙動を寄せたい" }).then((r) => r.json())).toEqual({ revisionRequested: true });
  const reportsDir = join(ctx.sessionsDir, sid, "reports");
  expect(existsSync(reportsDir) && readdirSync(reportsDir).length > 0).toBe(false);
});

test("textlint exempts an occurrence escaped with a backslash, storing the report with the backslash intact", async () => {
  const repoDir = makeTmpDir("repo");
  const configPath = writeTextlintConfig([{ string: "可能性", comment: "統計的事実のときだけ使う" }]);
  const { baseUrl, ctx } = await bootServer(repoDir, { configPath });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  await postJson(baseUrl, `/sessions/${sid}/revise-mode`, { enabled: true });

  // First submission held for the ordinary revision pass.
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "初稿" });

  // The escaped occurrence passes textlint; stored verbatim, backslash and all.
  const stored = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "\\可能性 は統計用語" }).then((r) => r.json());
  expect(stored.filename).toBe("001-p.md");
  expect(readFileSync(join(ctx.sessionsDir, sid, "reports", stored.filename), "utf8")).toBe("\\可能性 は統計用語");
});

test("a textlint bounce does not consume the one-shot revision cycle", async () => {
  const repoDir = makeTmpDir("repo");
  const configPath = writeTextlintConfig([{ string: "禁止", comment: "使わない" }]);
  const { baseUrl, ctx } = await bootServer(repoDir, { configPath });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  await postJson(baseUrl, `/sessions/${sid}/revise-mode`, { enabled: true });

  // First submission trips textlint: bounced before the general pass is entered.
  expect(await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "禁止語あり" }).then((r) => r.json())).toEqual({ revisionRequested: true });

  // A clean submission is now still treated as a first submission (general
  // revision pass), proving the textlint bounce left revisionPending untouched.
  expect(await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "綺麗な文" }).then((r) => r.json())).toEqual({ revisionRequested: true });

  const stored = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "綺麗な文" }).then((r) => r.json());
  expect(stored.filename).toBe("001-p.md");
  expect(readFileSync(join(ctx.sessionsDir, sid, "reports", stored.filename), "utf8")).toBe("綺麗な文");
});

test("textlint config edits take effect without a server restart", async () => {
  const repoDir = makeTmpDir("repo");
  const configPath = writeTextlintConfig([{ string: "禁止", comment: "旧ルール" }]);
  const { baseUrl, ctx } = await bootServer(repoDir, { configPath });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  await postJson(baseUrl, `/sessions/${sid}/revise-mode`, { enabled: true });

  // The original rule is in force.
  expect(await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "禁止あり" }).then((r) => r.json())).toEqual({ revisionRequested: true });

  // Rewrite the config in place — no restart.
  writeFileSync(configPath, 'textlint:\n  - string: "別語"\n    comment: "新ルール"\n');

  // The new rule is active: a report tripping it is bounced with its comment.
  expect(await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "別語あり" }).then((r) => r.json())).toEqual({ revisionRequested: true });
  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  const latest = readdirSync(inboxDir).filter((f) => f.endsWith(".md")).sort().at(-1) as string;
  expect(readFileSync(join(inboxDir, latest), "utf8")).toContain("新ルール");

  // The retired rule no longer fires: 「禁止」 now clears textlint and, after the
  // ordinary one-shot revision pass, stores — which a live rule would block.
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "禁止あり" });
  const stored = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "禁止あり" }).then((r) => r.json());
  expect(stored.filename).toBe("001-p.md");
});

test("textlint does not run when revise mode is off: a forbidden string stores on first submission", async () => {
  const repoDir = makeTmpDir("repo");
  const configPath = writeTextlintConfig([{ string: "禁止", comment: "使わない" }]);
  const { baseUrl, ctx } = await bootServer(repoDir, { configPath });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const stored = await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "p", content: "禁止語あり" }).then((r) => r.json());
  expect(stored.filename).toBe("001-p.md");
  expect(readFileSync(join(ctx.sessionsDir, sid, "reports", stored.filename), "utf8")).toBe("禁止語あり");
});

function writeConfigYaml(body: string): string {
  const dir = makeTmpDir("worqload-config");
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, body);
  return configPath;
}

test("a reviseFeedback override replaces the guidance in the bounce while the fixed scaffold (draft path and resubmit command) stays", async () => {
  const repoDir = makeTmpDir("repo");
  const configPath = writeConfigYaml('reviseFeedback: "CUSTOM-GUIDANCE 結論から書け"\n');
  const { baseUrl, ctx } = await bootServer(repoDir, { configPath });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  await postJson(baseUrl, `/sessions/${sid}/revise-mode`, { enabled: true });

  expect(await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plan", content: "初稿" }).then((r) => r.json())).toEqual({ revisionRequested: true });

  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  const latest = readdirSync(inboxDir).filter((f) => f.endsWith(".md")).sort().at(-1) as string;
  const body = readFileSync(join(inboxDir, latest), "utf8");
  // The injected guidance is present.
  expect(body).toContain("CUSTOM-GUIDANCE 結論から書け");
  // The fixed scaffold — draft path and the slug-bearing resubmit command — is still there.
  expect(body).toContain(".worqload-draft/revision-draft.md");
  expect(body).toContain("worqload report submit --slug plan");
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
    attachmentMaxBytes: 16,
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
    attachmentMaxCount: 2,
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
