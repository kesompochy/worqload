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

test("POST /sessions/archived/prune deletes archives older than the given days, keeping newer ones", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const stale = await postJson(baseUrl, "/sessions", { prompt: "stale", baseBranch: TEST_BASE }).then((r) => r.json());
  const fresh = await postJson(baseUrl, "/sessions", { prompt: "fresh", baseBranch: TEST_BASE }).then((r) => r.json());
  for (const sid of [stale.meta.id, fresh.meta.id]) {
    await postJson(baseUrl, `/sessions/${sid}/stop`, {});
    await postJson(baseUrl, `/sessions/${sid}/archive`, {});
  }

  // Backdate the stale session's archivedAt to 10 days ago; the fresh one keeps
  // its just-now archivedAt.
  const staleMeta = await loadSessionMeta(stale.meta.id, ctx.sessionsDir);
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  await saveSessionMeta({ ...staleMeta!, archivedAt: tenDaysAgo }, ctx.sessionsDir);

  const res = await fetch(`${baseUrl}/sessions/archived/prune`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ days: 7 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.deleted).toEqual([stale.meta.id]);

  expect(existsSync(join(ctx.sessionsDir, stale.meta.id))).toBe(false);
  expect(existsSync(join(ctx.sessionsDir, fresh.meta.id))).toBe(true);

  const remaining = await fetch(`${baseUrl}/sessions?archived=only`).then((r) => r.json());
  expect(remaining.sessions.map((s: { id: string }) => s.id)).toEqual([fresh.meta.id]);
});

test("POST /sessions/archived/prune rejects a non-numeric days value", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const res = await fetch(`${baseUrl}/sessions/archived/prune`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ days: "soon" }),
  });
  expect(res.status).toBe(400);
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

// Regression: two resume triggers can fire near-simultaneously — two feedback
// POSTs that each find no client (respawnMissingClient), or a manual Resume
// racing the wake watchdog. Each one independently spawned a host and the
// later `ctx.clients.set` silently overwrote — and abandoned — the host the
// other had just started. Over a wedged session's lifetime this stacked up
// many live `claude --continue` processes on one worktree, which is the
// post-stop/resume hang. spawnAndAttachHost must serialise per session and
// tear the previous host down before attaching the replacement.
test("racing respawns of a clientless session leave exactly one host", async () => {
  const repoDir = makeTmpDir("repo");
  let live = 0;
  let peakLive = 0;
  let releaseResumeSpawn!: () => void;
  const resumeSpawnGate = new Promise<void>((r) => {
    releaseResumeSpawn = r;
  });
  const captured: { onDisconnect: () => void; die: () => void }[] = [];

  let resumeLauncherCalls = 0;
  const launcher: HostLauncher = async ({ meta, sessionsDir, resume, onEvent, onDisconnect }) => {
    // Hold every resume spawn open so the test can line two of them up in
    // flight before either attaches.
    if (resume) {
      resumeLauncherCalls++;
      await resumeSpawnGate;
    }
    const event = await appendEvent(
      meta.id,
      { kind: resume ? "session_resumed" : "session_started", payload: { prompt: meta.prompt } },
      sessionsDir,
    );
    onEvent(event);
    live++;
    peakLive = Math.max(peakLive, live);
    let resolveExited!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolveExited = r;
    });
    let dead = false;
    const die = () => {
      if (dead) return;
      dead = true;
      live--;
      resolveExited(null);
    };
    captured.push({ onDisconnect, die });
    return {
      client: {
        async send() {},
        async kill() {
          die();
        },
        async close() {
          die();
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
    hostLauncher: launcher,
    worktreeOps: fakeWorktreeOps(),
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  expect(live).toBe(1);

  // The host's socket drops while the session is still 'running': its
  // attachment leaves ctx.clients and its process is gone.
  captured[0].onDisconnect();
  captured[0].die();
  expect(live).toBe(0);

  // First feedback finds no client and starts a respawn; it parks in the
  // gated launcher. The second feedback then lands (on its own connection,
  // since the first is still in flight) and ALSO finds no client — the
  // respawn the first started has not attached yet.
  const f1 = postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "one", slug: "f" });
  while (resumeLauncherCalls < 1) await new Promise((r) => setTimeout(r, 5));
  const f2 = postJson(baseUrl, `/sessions/${sid}/feedback`, { content: "two", slug: "f" });
  await new Promise((r) => setTimeout(r, 50));
  releaseResumeSpawn();
  await Promise.all([f1, f2]);
  await new Promise((r) => setTimeout(r, 50));

  expect(peakLive).toBe(1);
  expect(live).toBe(1);
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
  expect(files[0]).toMatch(/-feedback\.md$/);
  expect(readFileSync(join(inboxDir, files[0]), "utf8")).toContain("now do the other thing");
});

test("POST /sessions/:id/resume launches a fresh (non-resume) host for a startPaused session", async () => {
  const repoDir = makeTmpDir("repo");
  const launches: { resume: boolean }[] = [];
  const trackingLauncher: HostLauncher = async (req) => {
    launches.push({ resume: req.resume });
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

  const created = await postJson(baseUrl, "/sessions", {
    prompt: "x",
    baseBranch: TEST_BASE,
    startPaused: true,
  }).then((r) => r.json());
  const sid = created.meta.id;
  expect(created.meta.status).toBe("stopped");
  expect(launches).toHaveLength(0);

  const resumed = await postJson(baseUrl, `/sessions/${sid}/resume`, {}).then((r) => r.json());
  expect(resumed.meta.status).toBe("running");
  expect(launches).toHaveLength(1);
  expect(launches[0].resume).toBe(false);
});
