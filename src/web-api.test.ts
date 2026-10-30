import { test, expect, beforeEach, afterEach } from "bun:test";

// The real web/api.js under a stubbed fetch. The query suffix gives this file
// its own module instance: the handlers tests replace "../web/api.js" with
// mock.module, which holds for the whole bun process.
const { refreshDetail, refreshDiff, ensureFilesLoaded, fetchActions } = await import("../web/api.js?real");
const { state } = await import("../web/state.svelte.js");

// Holds every response until the test releases it, so a test can decide the
// order in which two sessions' responses land.
const pending = new Map<string, Array<() => void>>();

function bodyFor(path: string): unknown {
  const [, , id, resource] = path.split(/[/?]/);
  switch (resource) {
    case undefined: return { meta: { id }, events: [{ seq: 1 }], agentName: "claude" };
    case "reports": return { reports: [{ filename: `${id}.md` }] };
    case "asking": return { asking: [] };
    case "feedback": return { messages: [] };
    case "files": return { paths: [`${id}.txt`] };
    case "actions": return { actions: [{ id }] };
    case "diff": return `diff of ${id}`;
    default: throw new Error(`unexpected path ${path}`);
  }
}

const stubFetch = (url: string) => {
  const path = String(url);
  const id = path.split("/")[2];
  return new Promise<Response>(resolve => {
    const body = bodyFor(path);
    const response = typeof body === "string"
      ? new Response(body)
      : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    pending.set(id, [...(pending.get(id) ?? []), () => resolve(response)]);
  });
};

async function release(id: string) {
  for (const resolve of pending.get(id) ?? []) resolve();
  pending.delete(id);
  await new Promise(resolve => setImmediate(resolve));
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = stubFetch;
  pending.clear();
  state.activeTab = "reports";
  state.detail = null;
  state.reports = [];
  state.diff = "";
  state.files = [];
  state.filesLoaded = false;
  state.actions = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("refreshDetail discards a response that lands after another session was selected", async () => {
  state.selected = "a";
  const first = refreshDetail();
  state.selected = "b";
  const second = refreshDetail();
  await release("b");
  await release("a");
  await Promise.all([first, second]);
  expect(state.detail.meta.id).toBe("b");
  expect(state.reports).toEqual([{ filename: "b.md" }]);
});

test("refreshDiff discards a response that lands after another session was selected", async () => {
  state.selected = "a";
  const first = refreshDiff();
  state.selected = "b";
  const second = refreshDiff();
  await release("b");
  await release("a");
  await Promise.all([first, second]);
  expect(state.diff).toBe("diff of b");
});

test("ensureFilesLoaded discards a response that lands after another session was selected", async () => {
  state.selected = "a";
  const first = ensureFilesLoaded(true);
  state.selected = "b";
  const second = ensureFilesLoaded(true);
  await release("b");
  await release("a");
  await Promise.all([first, second]);
  expect(state.files).toEqual(["b.txt"]);
});

test("fetchActions discards a response that lands after another session was selected", async () => {
  state.selected = "a";
  const first = fetchActions("a");
  state.selected = "b";
  const second = fetchActions("b");
  await release("b");
  await release("a");
  await Promise.all([first, second]);
  expect(state.actions).toEqual([{ id: "b" }]);
});
