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

test("POST /internal/reports (multipart) stores attachments in a sibling .attachments dir", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const form = new FormData();
  form.set("payload", JSON.stringify({ slug: "done", content: "task complete" }));
  form.append("attachment", new File([png], "Result Shot.png", { type: "image/png" }));
  form.append("attachment", new File([png], "diagram.webp", { type: "image/webp" }));

  const res = await fetch(`${baseUrl}/internal/sessions/${sid}/reports`, { method: "POST", body: form });
  expect(res.status).toBe(200);
  expect((await res.json()).filename).toBe("001-done.md");

  const reportsDir = join(ctx.sessionsDir, sid, "reports");
  expect(readFileSync(join(reportsDir, "001-done.md"), "utf8")).toBe("task complete");
  const attachDir = join(reportsDir, "001-done.attachments");
  expect(readdirSync(attachDir).sort()).toEqual(["01-Result-Shot.png", "02-diagram.webp"]);
  expect(new Uint8Array(readFileSync(join(attachDir, "01-Result-Shot.png")))).toEqual(png);
});

test("GET /sessions/:id/reports exposes attachments on each report", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const form = new FormData();
  form.set("payload", JSON.stringify({ slug: "done", content: "see the shot" }));
  form.append("attachment", new File([png], "shot.png", { type: "image/png" }));
  await fetch(`${baseUrl}/internal/sessions/${sid}/reports`, { method: "POST", body: form });

  // A report submitted without attachments carries no attachments field.
  await postJson(baseUrl, `/internal/sessions/${sid}/reports`, { slug: "plain", content: "no image" });

  const res = await fetch(`${baseUrl}/sessions/${sid}/reports`).then((r) => r.json());
  const byName = Object.fromEntries(res.reports.map((r: { filename: string; attachments?: string[] }) => [r.filename, r.attachments]));
  expect(byName["001-done.md"]).toEqual(["01-shot.png"]);
  expect(byName["002-plain.md"]).toBeUndefined();
});

test("GET /sessions/:id/reports/:filename/attachments/:name streams the bytes", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const form = new FormData();
  form.set("payload", JSON.stringify({ slug: "done", content: "see" }));
  form.append("attachment", new File([png], "shot.png", { type: "image/png" }));
  await fetch(`${baseUrl}/internal/sessions/${sid}/reports`, { method: "POST", body: form });

  const res = await fetch(`${baseUrl}/sessions/${sid}/reports/001-done.md/attachments/01-shot.png`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
});

test("GET report attachments endpoint rejects path traversal in :name", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await fetch(
    `${baseUrl}/sessions/${sid}/reports/001-x.md/attachments/${encodeURIComponent("../../../etc/passwd")}`,
  );
  expect(res.status).toBe(400);
});

test("a report bounced for revision stores none of its attachments", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl, ctx } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  await postJson(baseUrl, `/sessions/${sid}/revise-mode`, { enabled: true });

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const form = new FormData();
  form.set("payload", JSON.stringify({ slug: "draft", content: "first draft" }));
  form.append("attachment", new File([png], "shot.png", { type: "image/png" }));

  const res = await fetch(`${baseUrl}/internal/sessions/${sid}/reports`, { method: "POST", body: form });
  expect(await res.json()).toEqual({ revisionRequested: true });
  expect(existsSync(join(ctx.sessionsDir, sid, "reports", "001-draft.attachments"))).toBe(false);
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

test("GET /sessions/:id/file flags image files with their media type", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

  const body = await fetch(`${baseUrl}/sessions/${sid}/file?path=pic.png`).then((r) => r.json());
  expect(body.image).toBe(true);
  expect(body.mediaType).toBe("image/png");
  expect(body.binary).toBeUndefined();
});

test("GET /sessions/:id/file/raw serves an image file's bytes", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  writeFileSync(join(created.meta.worktreePath, "pic.png"), pngBytes);

  const res = await fetch(`${baseUrl}/sessions/${sid}/file/raw?path=pic.png`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(pngBytes));
});

test("GET /sessions/:id/file/raw rejects escaping paths and non-image files", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "notes.txt"), "alpha\n");

  const escaping = await fetch(`${baseUrl}/sessions/${sid}/file/raw?path=${encodeURIComponent("../".repeat(20) + "etc/hosts")}`);
  expect(escaping.status).toBe(403);
  expect((await fetch(`${baseUrl}/sessions/${sid}/file/raw?path=notes.txt`)).status).toBe(400);
  expect((await fetch(`${baseUrl}/sessions/${sid}/file/raw?path=nope.png`)).status).toBe(404);
});

function putJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("PUT /sessions/:id/file overwrites a worktree file's content", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "notes.txt"), "old\n");

  const res = await putJson(baseUrl, `/sessions/${sid}/file?path=notes.txt`, { content: "new content\n" });
  expect(res.status).toBe(200);

  const reread = await fetch(`${baseUrl}/sessions/${sid}/file?path=notes.txt`).then((r) => r.json());
  expect(reread.content).toBe("new content\n");
});

test("PUT /sessions/:id/file rejects paths that escape the worktree", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await putJson(baseUrl, `/sessions/${sid}/file?path=${encodeURIComponent("../".repeat(20) + "tmp/leak")}`, { content: "x" });
  expect(res.status).toBe(403);
});

test("PUT /sessions/:id/file returns 404 for a missing file, 400 without a path or content", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  expect((await putJson(baseUrl, `/sessions/${sid}/file?path=nope.txt`, { content: "x" })).status).toBe(404);
  expect((await putJson(baseUrl, `/sessions/${sid}/file`, { content: "x" })).status).toBe(400);
  expect((await putJson(baseUrl, `/sessions/${sid}/file?path=notes.txt`, {})).status).toBe(400);
});

test("POST /sessions/:id/file creates a new worktree file", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  const res = await postJson(baseUrl, `/sessions/${sid}/file`, { path: "made.txt", content: "made by ui\n" });
  expect(res.status).toBe(200);

  const reread = await fetch(`${baseUrl}/sessions/${sid}/file?path=made.txt`).then((r) => r.json());
  expect(reread.content).toBe("made by ui\n");
});

test("POST /sessions/:id/file returns 409 when the file already exists", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "taken.txt"), "original\n");

  expect((await postJson(baseUrl, `/sessions/${sid}/file`, { path: "taken.txt" })).status).toBe(409);
});

test("POST /sessions/:id/file rejects escaping paths and a missing path", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  expect((await postJson(baseUrl, `/sessions/${sid}/file`, { path: "../".repeat(20) + "tmp/leak" })).status).toBe(403);
  expect((await postJson(baseUrl, `/sessions/${sid}/file`, {})).status).toBe(400);
});

test("DELETE /sessions/:id/file removes a worktree file", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "doomed.txt"), "x\n");

  const res = await fetch(`${baseUrl}/sessions/${sid}/file?path=doomed.txt`, { method: "DELETE" });
  expect(res.status).toBe(200);
  expect((await fetch(`${baseUrl}/sessions/${sid}/file?path=doomed.txt`)).status).toBe(404);
});

test("DELETE /sessions/:id/file returns 404 for a missing file, 403 for escaping paths, 400 without a path", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;

  expect((await fetch(`${baseUrl}/sessions/${sid}/file?path=nope.txt`, { method: "DELETE" })).status).toBe(404);
  expect((await fetch(`${baseUrl}/sessions/${sid}/file?path=${encodeURIComponent("../".repeat(20) + "etc/hosts")}`, { method: "DELETE" })).status).toBe(403);
  expect((await fetch(`${baseUrl}/sessions/${sid}/file`, { method: "DELETE" })).status).toBe(400);
});

test("POST /sessions/:id/file/rename renames a worktree file", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "before.txt"), "stays\n");

  const res = await postJson(baseUrl, `/sessions/${sid}/file/rename`, { from: "before.txt", to: "after.txt" });
  expect(res.status).toBe(200);

  expect((await fetch(`${baseUrl}/sessions/${sid}/file?path=before.txt`)).status).toBe(404);
  const reread = await fetch(`${baseUrl}/sessions/${sid}/file?path=after.txt`).then((r) => r.json());
  expect(reread.content).toBe("stays\n");
});

test("POST /sessions/:id/file/rename returns 409 when the destination already exists", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "from.txt"), "from\n");
  writeFileSync(join(created.meta.worktreePath, "to.txt"), "to\n");

  expect((await postJson(baseUrl, `/sessions/${sid}/file/rename`, { from: "from.txt", to: "to.txt" })).status).toBe(409);
});

test("POST /sessions/:id/file/rename rejects a missing source, escaping paths, and missing fields", async () => {
  const repoDir = makeTmpDir("repo");
  const { baseUrl } = await bootServer(repoDir);

  const created = await postJson(baseUrl, "/sessions", { prompt: "x", baseBranch: TEST_BASE }).then((r) => r.json());
  const sid = created.meta.id;
  writeFileSync(join(created.meta.worktreePath, "real.txt"), "x\n");

  expect((await postJson(baseUrl, `/sessions/${sid}/file/rename`, { from: "ghost.txt", to: "new.txt" })).status).toBe(404);
  expect((await postJson(baseUrl, `/sessions/${sid}/file/rename`, { from: "real.txt", to: "../".repeat(20) + "tmp/leak" })).status).toBe(403);
  expect((await postJson(baseUrl, `/sessions/${sid}/file/rename`, { from: "real.txt" })).status).toBe(400);
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
