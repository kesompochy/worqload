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

test("command approval: approve preserves the agent's stated reason in the result feedback", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const reason = "the release artifact must be published before the window closes";
  await postJson(baseUrl, `/internal/sessions/${sid}/command-approvals`, { command: "echo approved-ok", reason });

  await postJson(baseUrl, `/sessions/${sid}/escalations/001-command-approval.md/resolve`, { decision: "approve" });

  const inbox = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  expect(inbox.messages[0].content).toContain(reason);
});

test("command approval: reject preserves the agent's stated reason in the result feedback", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const reason = "the release artifact must be published before the window closes";
  await postJson(baseUrl, `/internal/sessions/${sid}/command-approvals`, { command: "echo hi", reason });

  await postJson(baseUrl, `/sessions/${sid}/escalations/001-command-approval.md/resolve`, {
    decision: "reject",
    content: "we publish from CI, not locally",
  });

  const inbox = await fetch(`${baseUrl}/internal/sessions/${sid}/feedback`).then((r) => r.json());
  expect(inbox.messages[0].content).toContain(reason);
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

// ---------------------------------------------------------------------------
// POST /sessions/:id/feedback/batch
// ---------------------------------------------------------------------------

test("POST /feedback/batch writes multiple feedback files and sends one wake", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await postJson(baseUrl, `/sessions/${sid}/feedback/batch`, {
    items: [
      { content: "first item", slug: "feedback" },
      { content: "second item", slug: "feedback" },
      { content: "third item", slug: "anchored", anchor: { path: "README.md", lineStart: 1, lineEnd: 3 } },
    ],
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.results).toHaveLength(3);
  expect(body.results[0].filename).toBe("001-feedback.md");
  expect(body.results[1].filename).toBe("002-feedback.md");
  expect(body.results[2].filename).toBe("003-anchored.md");

  const inboxDir = join(ctx.sessionsDir, sid, "feedback", "inbox");
  expect(readFileSync(join(inboxDir, "001-feedback.md"), "utf8")).toBe("first item");
  expect(readFileSync(join(inboxDir, "002-feedback.md"), "utf8")).toBe("second item");
  expect(readFileSync(join(inboxDir, "003-anchored.md"), "utf8")).toBe("third item");

  const logPath = hostLogPath(ctx.sessionsDir, sid);
  const entries = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const wakes = entries.filter((e) => e.event === "wake_sent");
  expect(wakes).toHaveLength(1);
});

test("POST /feedback/batch rejects an empty items array", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await postJson(baseUrl, `/sessions/${sid}/feedback/batch`, { items: [] });
  expect(res.status).toBe(400);
});

test("POST /feedback/batch rejects when items is missing", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await postJson(baseUrl, `/sessions/${sid}/feedback/batch`, { content: "not batch" });
  expect(res.status).toBe(400);
});

test("POST /feedback/batch broadcasts one feedback_received event per item", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  await postJson(baseUrl, `/sessions/${sid}/feedback/batch`, {
    items: [
      { content: "a", slug: "feedback" },
      { content: "b", slug: "feedback" },
    ],
  });

  const events = await readEvents(sid, 1, ctx.sessionsDir);
  const feedbackEvents = events.filter((e) => e.kind === "feedback_received");
  expect(feedbackEvents).toHaveLength(2);
});
