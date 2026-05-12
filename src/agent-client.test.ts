import { test, expect, afterEach } from "bun:test";
import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { startServer } from "./web-server";
import { submitReport, submitEscalation, requestCommandApproval, fetchFeedback } from "./agent-client";
import { makeTmpDir, cleanupAll, trackCleanup } from "./test-helpers";

afterEach(cleanupAll);

const cleanGitEnv = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };
const TEST_BASE = "trunk";
const MOCK = join(import.meta.dir, "__fixtures__", "mock-claude.ts");
const CLI = join(import.meta.dir, "cli.ts");
const HOST_COMMAND = ["bun", CLI, "session-host"];

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: cleanGitEnv });
}

function makeRepo(): string {
  const dir = makeTmpDir("agent-client-test");
  git(["init"], dir);
  git(["checkout", "-b", TEST_BASE], dir);
  git(["config", "user.email", "t@t.com"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "README.md"), "# t\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

async function bootAndCreateSession(): Promise<{ endpoint: string; sessionId: string }> {
  const repoDir = makeRepo();
  const started = await startServer({
    port: 0,
    repoDir,
    spawnCommand: ["bun", MOCK, "hang"],
    branchNameGenerator: async () => null,
    hostCommand: HOST_COMMAND,
  });
  trackCleanup(() => started.shutdown({ killHosts: true }));
  const endpoint = `http://127.0.0.1:${started.server.port}`;
  const created = await fetch(`${endpoint}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x", baseBranch: TEST_BASE }),
  }).then(r => r.json());
  return { endpoint, sessionId: created.meta.id };
}

test("submitReport posts a numbered report", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();

  const r = await submitReport(endpoint, sessionId, "plan", "this is the plan");
  expect(r.filename).toBe("001-plan.md");
  expect(r.seq).toBe(1);
});

test("submitEscalation flips status to waiting_human", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();

  const e = await submitEscalation(endpoint, sessionId, "which-lib", "X or Y?");
  expect(e.filename).toBe("001-which-lib.md");

  const detail = await fetch(`${endpoint}/sessions/${sessionId}`).then(r => r.json());
  expect(detail.meta.status).toBe("waiting_human");
});

test("requestCommandApproval files a command-approval escalation", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();

  const r = await requestCommandApproval(endpoint, sessionId, "npm publish", "release it");
  expect(r.filename).toBe("001-command-approval.md");

  const detail = await fetch(`${endpoint}/sessions/${sessionId}`).then(r => r.json());
  expect(detail.meta.status).toBe("waiting_human");

  const asking = await fetch(`${endpoint}/sessions/${sessionId}/asking`).then(r => r.json());
  expect(asking.asking[0].command).toBe("npm publish");
});

test("fetchFeedback returns and drains the inbox", async () => {
  const { endpoint, sessionId } = await bootAndCreateSession();

  await fetch(`${endpoint}/sessions/${sessionId}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "hi", slug: "say-hi" }),
  });

  const first = await fetchFeedback(endpoint, sessionId);
  expect(first.messages).toHaveLength(1);
  expect(first.messages[0].content).toBe("hi");

  // second fetch returns empty (already drained)
  const second = await fetchFeedback(endpoint, sessionId);
  expect(second.messages).toEqual([]);
});

test("submitReport throws on non-existent session", async () => {
  const { endpoint } = await bootAndCreateSession();

  await expect(submitReport(endpoint, "nonexistent-session-id", "x", "y")).rejects.toThrow();
});
