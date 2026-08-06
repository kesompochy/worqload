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

// Wraps inProcessHostLauncher to (a) record every message serve sends to the
// host and (b) expose the onEvent callback so a test can feed driver events
// (e.g. the normalized turn_completed signal) through the server's broadcast
// path.
function capturingHostLauncher() {
  const base = inProcessHostLauncher();
  const sends: string[] = [];
  let onEvent: ((event: Awaited<ReturnType<typeof appendEvent>>) => void) | undefined;
  const launcher: HostLauncher = async (req) => {
    onEvent = req.onEvent;
    const { client } = await base(req);
    return { client: { ...client, async send(text: string) { sends.push(text); } } };
  };
  return {
    launcher,
    sends,
    // Simulate the host forwarding a driver's normalized turn-end signal.
    // seq/timestamp are irrelevant to the auto-nudge logic, which keys off kind.
    endTurn: () => onEvent?.({ seq: 0, kind: "turn_completed", timestamp: "", payload: {} }),
  };
}

test("a turn that ends without a report is nudged with a message to the agent", async () => {
  const repoDir = makeTmpDir("repo");
  const host = capturingHostLauncher();
  const { baseUrl } = await bootServer(repoDir, { hostLauncher: host.launcher, maxAutoNudges: 2 });

  await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());

  host.endTurn();
  expect(host.sends.length).toBe(1);
});

test("a turn that submitted a report is left alone", async () => {
  const repoDir = makeTmpDir("repo");
  const host = capturingHostLauncher();
  const { baseUrl } = await bootServer(repoDir, { hostLauncher: host.launcher, maxAutoNudges: 2 });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "progress", content: "did the thing" });
  host.endTurn();
  expect(host.sends.length).toBe(0);
});

test("consecutive report-less turns stop being nudged after maxAutoNudges", async () => {
  const repoDir = makeTmpDir("repo");
  const host = capturingHostLauncher();
  const { baseUrl } = await bootServer(repoDir, { hostLauncher: host.launcher, maxAutoNudges: 2 });

  await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());

  host.endTurn();
  host.endTurn();
  host.endTurn();
  expect(host.sends.length).toBe(2);
});

test("a report resets the nudge budget for later report-less turns", async () => {
  const repoDir = makeTmpDir("repo");
  const host = capturingHostLauncher();
  const { baseUrl } = await bootServer(repoDir, { hostLauncher: host.launcher, maxAutoNudges: 1 });

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  host.endTurn(); // report-less → nudge (budget now spent)
  host.endTurn(); // still report-less, budget spent → no nudge
  expect(host.sends.length).toBe(1);

  // A real report clears the consecutive count.
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "progress", content: "done step" });
  host.endTurn(); // turn that carried the report → no nudge
  host.endTurn(); // fresh report-less turn → nudge again
  expect(host.sends.length).toBe(2);
});

test("maxAutoNudges=0 disables the report-less nudge entirely", async () => {
  const repoDir = makeTmpDir("repo");
  const host = capturingHostLauncher();
  const { baseUrl } = await bootServer(repoDir, { hostLauncher: host.launcher, maxAutoNudges: 0 });

  await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());

  host.endTurn();
  host.endTurn();
  expect(host.sends.length).toBe(0);
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
