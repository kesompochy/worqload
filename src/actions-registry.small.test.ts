import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  findAction,
  isSessionPreviewAlive,
  listActions,
  parsePreviewListeningUrl,
  previewAction,
  previewPortForSession,
  stopPreviewAction,
  stopSessionPreview,
} from "./actions";
import type { SessionMeta } from "./session";
import { cleanupAll, makeTmpDir } from "./test-helpers";

afterEach(cleanupAll);



function metaWithWorktree(worktreePath: string): SessionMeta {
  return {
    id: crypto.randomUUID(),
    prompt: "p",
    title: "p",
    baseBranch: "main",
    baseCommit: "x",
    worktreePath,
    branchName: "b",
    status: "running",
    createdAt: new Date().toISOString(),
  };
}


// The pidfile lives under <previewRoot>/<shortId>/.worqload/preview.pid; that
// path mirrors `previewPaths()` exactly so the helper under test reads the
// file we just wrote.
function writePreviewPid(root: string, sessionId: string, pid: number, logBody?: string): void {
  const shortId = sessionId.slice(0, 8);
  const dir = join(root, shortId, ".worqload");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "preview.pid"), String(pid));
  if (logBody !== undefined) writeFileSync(join(root, `${shortId}.log`), logBody);
}


test("registry exposes built-in actions and supports lookup", () => {
  const list = listActions();
  expect(list.find((a) => a.id === "merge-to-base")).toBeDefined();
  expect(list.find((a) => a.id === "merge-from-base")).toBeDefined();
  expect(list.find((a) => a.id === "create-pr")).toBeDefined();
  expect(list.find((a) => a.id === "sync-base-from-remote")).toBeDefined();
  expect(list.find((a) => a.id === "preview")?.direct).toBe(true);
  expect(list.find((a) => a.id === "stop-preview")?.direct).toBe(true);
  // panel actions stay non-direct
  expect(list.find((a) => a.id === "merge-to-base")?.direct).toBeUndefined();
  expect(list.find((a) => a.id === "sync-base-from-remote")?.direct).toBeUndefined();
  // descriptors must not include the run function or the availableFor predicate
  for (const d of list) {
    expect((d as { run?: unknown }).run).toBeUndefined();
    expect((d as { availableFor?: unknown }).availableFor).toBeUndefined();
  }
  expect(findAction("merge-to-base")?.id).toBe("merge-to-base");
  expect(findAction("nonexistent")).toBeUndefined();
});

test("previewPortForSession is stable, in range, and varies by session", () => {
  const a = previewPortForSession("11111111-2222-3333-4444-555555555555");
  const b = previewPortForSession("11111111-2222-3333-4444-555555555555");
  const c = previewPortForSession("99999999-8888-7777-6666-555555555555");
  expect(a).toBe(b);
  expect(a).toBeGreaterThanOrEqual(3500);
  expect(a).toBeLessThan(3700);
  expect(a).not.toBe(c);
});

test("parsePreviewListeningUrl pulls the URL out of the server's startup log", () => {
  expect(parsePreviewListeningUrl("worqload preview listening on http://127.0.0.1:3517\npreview repo: /x\n")).toBe(
    "http://127.0.0.1:3517",
  );
  expect(parsePreviewListeningUrl("building...\n")).toBeNull();
});

