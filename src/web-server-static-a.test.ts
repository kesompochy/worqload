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



test("POST /sessions/:id/resume sends a wake after fresh-starting a startPaused session with feedback", async () => {
  const repoDir = makeTmpDir("repo");
  const sentMessages: string[] = [];
  const trackingLauncher: HostLauncher = async (req) => {
    const result = await inProcessHostLauncher()(req);
    const origSend = result.client.send.bind(result.client);
    result.client.send = async (text: string) => {
      sentMessages.push(text);
      return origSend(text);
    };
    return result;
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

  await postJson(baseUrl, `/sessions/${sid}/resume`, { prompt: "now do stuff" });
  expect(sentMessages.some(m => m.includes("[wake]"))).toBe(true);
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

// Regression: makeSpawnHostLauncher used to send `hello {sinceSeq:0}` to every
// freshly-spawned host. The host honours that by replaying the whole event log
// back over the socket; serve forwards each event through onEvent →
// broadcastEvent → every subscribed WebSocket client. The visible damage shows
// up on resume (and on watchdog auto-resume): WS subscribers attached BEFORE
// the resume see the entire history re-broadcast on top of the new
// session_resumed event. The same path also stamps lastClaudeActivityAt with
// "now" for old claude_* events, which feeds the wake watchdog a false
// liveness signal.
test("resume does not re-broadcast the persisted event log over the WebSocket", async () => {
  const repoDir = makeTmpDir("repo");
  const started = await startServer({
    port: 0,
    repoDir,
    spawnCommand: ["bun", MOCK, "hang"],
    branchNameGenerator: async () => null,
    hostCommand: HOST_COMMAND,
    worktreeOps: fakeWorktreeOps(),
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const baseUrl = `http://127.0.0.1:${started.server.port}`;
  const ctx = started.ctx;

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  // Let the initial session_started + claude_system writes settle.
  await new Promise((r) => setTimeout(r, 200));
  await postJson(baseUrl, `/sessions/${sid}/stop`, {});
  await new Promise((r) => setTimeout(r, 200));

  const preResumeEvents = await readEvents(sid, 1, ctx.sessionsDir);
  const lastSeqBeforeResume = preResumeEvents.at(-1)?.seq ?? 0;
  expect(lastSeqBeforeResume).toBeGreaterThanOrEqual(2);

  // Subscribe pretending we already have every event up to the current tail.
  // After the fix only events with seq > lastSeqBeforeResume should reach us.
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/sessions/${sid}/stream`);
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
  const liveMessages: { event: { seq: number; kind: string } }[] = [];
  ws.addEventListener("message", (e) => {
    liveMessages.push(JSON.parse(typeof e.data === "string" ? e.data : ""));
  });
  ws.send(JSON.stringify({ type: "subscribe", lastSeq: lastSeqBeforeResume }));
  await new Promise((r) => setTimeout(r, 100));
  const startIndex = liveMessages.length;

  await postJson(baseUrl, `/sessions/${sid}/resume`, {});
  // Give the new host time to attach, complete the (now empty) hello replay,
  // and emit session_resumed plus the mock's bootstrap claude_system event.
  await new Promise((r) => setTimeout(r, 1000));

  ws.close();
  await new Promise((r) => setTimeout(r, 30));

  const resumeMessages = liveMessages.slice(startIndex);
  for (const m of resumeMessages) {
    expect(m.event.seq).toBeGreaterThan(lastSeqBeforeResume);
  }
  expect(resumeMessages.some((m) => m.event.kind === "session_resumed")).toBe(true);
});

// Regression: the WS subscribe handler does `await readEvents` (disk) before
// sending the replay. If `appendAndBroadcast` fires its `ws.send` during that
// await, the new event hits the wire BEFORE the replay events and the client
// filters `ev.seq <= state.lastSeq` discards the now-older replay events. The
// gap then stays invisible until the next refreshDetail (which is exactly
// what feedback-submission ends up triggering, hiding the bug from anyone who
// types into the composer regularly). Events the server pushes onto the WS
// after a subscribe must arrive in strictly increasing seq order — i.e. the
// subscribe handler must serialise broadcasts that race against the replay.
test("WS /sessions/:id/stream delivers subscribe replay and concurrent broadcasts in seq order", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  // Let the initial session_started settle, then keep producing events while
  // the subscribe is in flight: each POST is an `appendAndBroadcast` that can
  // race against the replay. We fire several so at least one lands during the
  // server's subscribe `await readEvents` window.
  await new Promise((r) => setTimeout(r, 100));
  const baselineSeq = (await readEvents(sid, 1, ctx.sessionsDir)).at(-1)?.seq ?? 0;

  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/sessions/${sid}/stream`);
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));

  const received: { event: { seq: number; kind: string } }[] = [];
  ws.addEventListener("message", (e) => {
    received.push(JSON.parse(typeof e.data === "string" ? e.data : ""));
  });

  ws.send(JSON.stringify({ type: "subscribe", lastSeq: baselineSeq }));
  const posts = Array.from({ length: 5 }, (_, i) =>
    postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: `race-${i}`, content: `r${i}` }),
  );
  await Promise.all(posts);

  await new Promise((r) => setTimeout(r, 300));
  ws.close();
  await new Promise((r) => setTimeout(r, 30));

  // Every event with seq > baselineSeq must reach the client exactly once.
  const seqs = received.map((m) => m.event.seq);
  const expectedTail = (await readEvents(sid, 1, ctx.sessionsDir)).at(-1)?.seq ?? 0;
  for (let s = baselineSeq + 1; s <= expectedTail; s++) {
    expect(seqs).toContain(s);
  }
  // And in strictly increasing order — the invariant the fix protects.
  for (let i = 1; i < seqs.length; i++) {
    expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  }
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
