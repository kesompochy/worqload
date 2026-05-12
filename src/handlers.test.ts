import { test, expect, mock } from "bun:test";

// selectSession reaches into the network (api); stub it so the per-session
// state reset can be asserted in isolation.
const reorderSessionsCalls: string[][] = [];
let fetchSessionsCalls = 0;
mock.module("../web/api.js", () => ({
  api: async () => ({}),
  fetchSessions: async () => { fetchSessionsCalls++; },
  reorderSessions: async (ids: string[]) => { reorderSessionsCalls.push(ids); },
  refreshDetail: async () => {},
  refreshDiff: async () => {},
  ensureFilesLoaded: async () => {},
  selectFile: async () => {},
  openWs() {},
}));
const { selectSession, extractPullRequestUrl, onDetailBodyClick, runOpenAction, onReorderSessions, onReportMark } = await import("../web/handlers.js");
const { state, isReportExpanded } = await import("../web/state.svelte.js");

// onDetailBodyClick reads its event off the DOM (e.target.closest); fake just
// enough of it: closest(selector) returns a stub element for the toggle row.
function reportToggleClick(filename) {
  const row = { getAttribute: (a) => (a === "data-report-toggle" ? filename : null) };
  return { target: { closest: (sel) => (sel === "[data-report-toggle]" ? row : null) } };
}

test("extractPullRequestUrl pulls the PR URL out of a create-pr run log", () => {
  const log = [
    "$ git push -u origin worqload/abc12345",
    "branch 'worqload/abc12345' set up to track 'origin/worqload/abc12345'.",
    "$ gh pr create --base main --head worqload/abc12345",
    "https://github.com/kesompochy/worqload/pull/42",
  ].join("\n");
  expect(extractPullRequestUrl(log)).toBe("https://github.com/kesompochy/worqload/pull/42");
});

test("extractPullRequestUrl returns null when the log has no PR URL", () => {
  expect(extractPullRequestUrl("$ git push -u origin foo\nEverything up-to-date")).toBeNull();
});

test("selectSession drops a line anchor left over from the previously viewed session", async () => {
  // An anchor's path is session-relative (e.g. ./.worqload-reports/<file>, a
  // path that only resolves inside that session's worktree). If it survives a
  // session switch, feedback typed for the new session goes out tagged
  // "Re: <a report the new session does not have>".
  state.selected = "session-a";
  state.anchor = { path: "./.worqload-reports/012-preview-url.md", lineStart: 3, lineEnd: 3 };

  await selectSession("session-b");

  expect(state.selected).toBe("session-b");
  expect(state.anchor).toBeNull();
});

test("clicking a report header toggles its expansion with a fresh Map (so Svelte re-renders)", () => {
  state.reports = [{ filename: "001-plan.md", content: "x", read: true }];
  state.reportToggle = new Map();
  const before = state.reportToggle;

  // read reports default to collapsed; first click expands.
  onDetailBodyClick(reportToggleClick("001-plan.md"));
  expect(state.reportToggle).not.toBe(before);
  expect(isReportExpanded(state.reports[0])).toBe(true);

  // second click collapses again.
  onDetailBodyClick(reportToggleClick("001-plan.md"));
  expect(isReportExpanded(state.reports[0])).toBe(false);
});

test("onReportMark refreshes the session list so the sidebar unread badge updates immediately", async () => {
  // The badge count comes from GET /sessions; without this fetch it would only
  // catch up on the next 30s poll (or whenever the report_read websocket event
  // round-trips back).
  state.selected = "session-a";
  fetchSessionsCalls = 0;

  await onReportMark("001-plan.md", true);

  expect(fetchSessionsCalls).toBe(1);
});

test("runOpenAction records the run on a fresh actionResults Map (so ActionBar re-renders)", async () => {
  // runOpenAction reads action-parameter inputs off the DOM (none here) and
  // pops a toast on completion; stub just enough document/window for that, and
  // restore the globals so later test files keep the real fetch/document.
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  const saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  globalThis.document = { getElementById: () => null, querySelector: () => toastEl };
  globalThis.window = { open() {} };
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }) });
  try {
    state.selected = "session-a";
    state.actions = [{ id: "noop", label: "Noop", params: [] }];
    state.openActionId = "noop";
    state.actionResults = new Map();
    state.actionRunInFlight = false;
    const before = state.actionResults;

    await runOpenAction();

    expect(state.actionResults).not.toBe(before);
    expect(state.actionResults.get("noop").ok).toBe(true);
    expect(state.actionRunInFlight).toBe(false);
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  }
});

test("onReorderSessions moves the dragged session before the target and persists the new order", async () => {
  state.sessions = [{ id: "a" }, { id: "b" }, { id: "c" }];
  reorderSessionsCalls.length = 0;

  await onReorderSessions("c", "a");

  expect(state.sessions.map((s: { id: string }) => s.id)).toEqual(["c", "a", "b"]);
  expect(reorderSessionsCalls).toEqual([["c", "a", "b"]]);
});

test("onReorderSessions appends the dragged session when the target is null", async () => {
  state.sessions = [{ id: "a" }, { id: "b" }, { id: "c" }];
  reorderSessionsCalls.length = 0;

  await onReorderSessions("a", null);

  expect(state.sessions.map((s: { id: string }) => s.id)).toEqual(["b", "c", "a"]);
  expect(reorderSessionsCalls).toEqual([["b", "c", "a"]]);
});

test("onReorderSessions is a no-op when dropped onto itself", async () => {
  state.sessions = [{ id: "a" }, { id: "b" }];
  reorderSessionsCalls.length = 0;

  await onReorderSessions("a", "a");

  expect(state.sessions.map((s: { id: string }) => s.id)).toEqual(["a", "b"]);
  expect(reorderSessionsCalls).toEqual([]);
});
