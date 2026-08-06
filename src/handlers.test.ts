import { test, expect, mock, afterEach } from "bun:test";

// addAttachmentFiles calls URL.createObjectURL on each accepted File and
// removeAttachment / clearAttachments call revokeObjectURL on the resulting
// blob URL. Bun's URL global lacks both, so stub them with counters the tests
// can read back. Counter shape lets a test assert "every created URL was
// revoked exactly once" without bookkeeping per call site.
let createObjectURLCount = 0;
const revokedObjectURLs: string[] = [];
(URL as unknown as { createObjectURL: (file: unknown) => string }).createObjectURL =
  () => `blob:fake/${++createObjectURLCount}`;
(URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL =
  (url: string) => { revokedObjectURLs.push(url); };

// selectSession reaches into the network (api); stub it so the per-session
// state reset can be asserted in isolation.
const reorderSessionsCalls: string[][] = [];
let fetchSessionsCalls = 0;
let fetchArchivedSessionsCalls = 0;
const apiCalls: Array<{ method: string; path: string; body?: unknown }> = [];
let saveFileCalls = 0;
const createFileCalls: string[] = [];
const deleteFileCalls: string[] = [];
const renameFileCalls: string[] = [];
const submitFeedbackCalls: Array<{ sessionId: string; payload: unknown; attachments: unknown }> = [];
const submitFeedbackBatchCalls: Array<{ sessionId: string; items: unknown }> = [];
const resolveEscalationCalls: Array<{ sessionId: string; filename: string; payload: unknown; attachments: unknown }> = [];
mock.module("../web/api.js", () => ({
  api: async (method: string, path: string, body?: unknown) => { apiCalls.push({ method, path, body }); return {}; },
  submitFeedback: async (sessionId: string, payload: unknown, attachments: unknown) => {
    submitFeedbackCalls.push({ sessionId, payload, attachments });
    return { filename: "001-x.md", seq: 1 };
  },
  submitFeedbackBatch: async (sessionId: string, items: unknown) => {
    submitFeedbackBatchCalls.push({ sessionId, items });
    return { results: [{ filename: "001-x.md", seq: 1 }] };
  },
  resolveEscalation: async (sessionId: string, filename: string, payload: unknown, attachments: unknown) => {
    resolveEscalationCalls.push({ sessionId, filename, payload, attachments });
    return { ok: true, answerFilename: "001-answer.md" };
  },
  fetchSessions: async () => { fetchSessionsCalls++; },
  fetchArchivedSessions: async () => { fetchArchivedSessionsCalls++; },
  fetchActions: async () => {},
  reorderSessions: async (ids: string[]) => { reorderSessionsCalls.push(ids); },
  refreshDetail: async () => {},
  loadPrLink: async () => {},
  refreshDiff: async () => {},
  ensureFilesLoaded: async () => {},
  ensureStructureLoaded: async () => {},
  ensureStructureBeforeLoaded: async () => {},
  ensureCallGraphLoaded: async () => {},
  ensureCallGraphBeforeLoaded: async () => {},
  ensureStructureViewLoaded: async () => {},
  selectFile: async () => {},
  saveFile: async () => { saveFileCalls++; },
  createFile: async (path: string) => { createFileCalls.push(path); },
  deleteFile: async (path: string) => { deleteFileCalls.push(path); },
  renameFile: async (path: string) => { renameFileCalls.push(path); },
  searchFiles: async () => ({ matches: [], truncated: false }),
  fetchCodeNavLocations: async () => ({ available: false }),
  openWs() {},
}));
const { selectSession, switchTab, extractPullRequestUrl, onDetailBodyClick, runOpenAction, onReorderSessions, onReportMark, revealReport, closeCodeNav, gotoAnchorTarget, gotoArticle, hideFeedbackPin, onDetailBodyPointerOver, onDetailBodyPointerOut, pushStructureFocus, popStructureFocus, clearStructureFocus, applyUrlState, onSidebarTab, onArchive, onDeleteArchived, onToggleArchivedSelection, onSelectAllArchived, onClearArchivedSelection, onBulkDeleteArchived, onUnarchive, toggleSidebar, onAnchorOutsideClick, addAttachmentFiles, removeAttachment, clearAttachments, addAskingAttachmentFiles, removeAskingAttachment, clearAskingAttachments, onFeedback, onQueueFeedback, removeQueuedFeedback, onFeedbackDelete, onResume, onStopAndResume, onToggleReviseMode, onResolve, onResolveCommand } = await import("../web/handlers.js");
const { state, isReportExpanded, isFeedbackExpanded } = await import("../web/state.svelte.js");


afterEach(() => {
  Object.assign(state, {
    sessions: [], archivedSessions: [], archivedSelection: new Set(),
    sidebarTab: "active", sidebarHidden: false, selected: null, detail: null,
    prLink: null, prLinks: {}, reports: [], asking: [], feedbackHistory: [],
    ws: null, lastSeq: 0, activeTab: "reports", tabScroll: new Map(),
    diff: "", anchor: null, collapsedFiles: new Set(), diffExpansions: new Map(),
    diffTreeCollapsed: new Set(), files: [], filesLoaded: false,
    fileTreeCollapsed: new Set(), selectedFilePath: null, fileContent: null,
    fileEditing: false, fileEditDraft: "", fileCreating: false, fileNewPath: "",
    fileRenaming: false, fileRenamePath: "", codeNav: null,
    structure: null, structureLoaded: false, structureBefore: null,
    structureBeforeLoaded: false, structureSplit: false,
    callGraph: null, callGraphLoaded: false, callGraphBefore: null,
    callGraphBeforeLoaded: false, structureMode: "file",
    structureShowSymbols: true, structureFocusStack: [], structureAnchor: null,
    structureHops: null, reportToggle: new Map(), reportViewRaw: new Map(),
    feedbackToggle: new Map(), eventToggle: new Map(), actions: [],
    openActionId: null, actionRunInFlight: false, runningActionId: null,
    actionResults: new Map(), renamingSessionId: null, pendingScrollTo: null,
    feedbackPinAt: null, pendingAttachments: [], askingAttachments: new Map(),
    feedbackQueue: [],
  });
  createObjectURLCount = 0;
  revokedObjectURLs.length = 0;
  reorderSessionsCalls.length = 0;
  fetchSessionsCalls = 0;
  fetchArchivedSessionsCalls = 0;
  apiCalls.length = 0;
  saveFileCalls = 0;
  createFileCalls.length = 0;
  deleteFileCalls.length = 0;
  renameFileCalls.length = 0;
  submitFeedbackCalls.length = 0;
  submitFeedbackBatchCalls.length = 0;
  resolveEscalationCalls.length = 0;
});

// A minimal window fake the URL-state sync writes into. Installed per test that
// needs it, removed at the end so other tests keep seeing the real globals.
// Tracks both pushState and replaceState calls; tests can read `lastUrl` for
// the latest write and `pushCount` for how many history entries were created.
function installUrlWindow(search = "") {
  let urlSearch = search;
  const apply = (url: string) => {
    urlSearch = new URL(url, "http://x").search;
    (fake as unknown as { lastUrl: string }).lastUrl = url;
  };
  const fake = {
    location: { get search() { return urlSearch; }, pathname: "/", hash: "" },
    history: {
      replaceState(_s: unknown, _t: string, url: string) { apply(url); },
      pushState(_s: unknown, _t: string, url: string) { apply(url); (fake as unknown as { pushCount: number }).pushCount++; },
    },
    lastUrl: search ? `/${search}` : "/",
    pushCount: 0,
  };
  (globalThis as unknown as { window: unknown }).window = fake;
  return fake;
}
function uninstallUrlWindow() {
  (globalThis as unknown as { window: unknown }).window = undefined;
}

// A fake of the striped [data-feedback-preview] line element the hover handlers
// delegate on.
function strikedLine(filenames: string) {
  return { getAttribute: (a: string) => (a === "data-feedback-preview" ? filenames : null), contains: () => false };
}
function overEvent(line: unknown, clientX = 100, clientY = 200) {
  return { target: { closest: (sel: string) => (sel === "[data-feedback-preview]" ? line : null) }, clientX, clientY };
}

// onDetailBodyClick reads its event off the DOM (e.target.closest); fake just
// enough of it: closest(selector) returns a stub element for the toggle row.
function reportToggleClick(filename) {
  const row = { getAttribute: (a) => (a === "data-report-toggle" ? filename : null) };
  return { target: { closest: (sel) => (sel === "[data-report-toggle]" ? row : null) } };
}

function gotoAnchorClick(path, lineStart, lineEnd) {
  const el = { getAttribute: (a) =>
    a === "data-goto-anchor-path" ? path :
    a === "data-goto-anchor-line" ? String(lineStart) :
    a === "data-goto-anchor-line-end" ? String(lineEnd) : null };
  return { target: { closest: (sel) => (sel === "[data-goto-anchor-path]" ? el : null) } };
}




// Fake DOM target whose `closest(sel)` resolves only the selectors listed in
// `ancestors`. Mirrors the way real `Element#closest` walks the DOM tree.
function targetIn(ancestors: string[]) {
  return {
    closest: (sel: string) => (ancestors.includes(sel) ? {} : null),
  };
}







function identTokenClick(symbol: string, path: string, line: number, container = ".file-content-body") {
  const lineEl = { getAttribute: (a: string) => (a === "data-anchor-path" ? path : a === "data-anchor-line" ? String(line) : null) };
  const token = {
    textContent: symbol,
    getBoundingClientRect: () => ({ top: 0, bottom: 10, left: 0 }),
    closest: (sel: string) => (sel === "[data-anchor-line]" ? lineEl : null),
  };
  // The production handler queries a comma-separated selector list to allow the
  // popover in either the Files or the Diff body — match this token's claimed
  // container against any entry in that list.
  const matchesContainer = (sel: string) => sel.split(",").map(s => s.trim()).includes(container);
  return { target: { closest: (sel: string) => (sel === ".tok-ident" ? token : matchesContainer(sel) ? {} : null) } };
}

test("clicking a symbol token in the Files content pane opens the code-nav popover, then resolves it via the heuristic fallback", async () => {
  state.selected = null; // no session selected → the server provider declines, heuristic answers
  state.fileContent = { path: "lib/app.js", content: "function greet(name) {}\ngreet('x');\n" };
  state.selectedFilePath = "lib/app.js";
  state.codeNav = null;

  onDetailBodyClick(identTokenClick("greet", "lib/app.js", 2));
  expect(state.codeNav?.symbol).toBe("greet");
  expect(state.codeNav?.path).toBe("lib/app.js");
  expect(state.codeNav?.definitionsStatus).toBe("loading");
  expect(state.codeNav?.referencesStatus).toBe("loading");

  await new Promise(r => setTimeout(r, 5));
  expect(state.codeNav?.definitionsStatus).toBe("done");
  expect(state.codeNav?.definitions).toEqual([
    { path: "lib/app.js", line: 1, column: "function ".length, text: "function greet(name) {}" },
  ]);
  expect(state.codeNav?.referencesStatus).toBe("done");
  expect(state.codeNav?.references).toEqual([]);

  closeCodeNav();
  expect(state.codeNav).toBeNull();
});

test("clicking a symbol token in the Diff body opens the code-nav popover for that diff file", async () => {
  // The diff line carries `data-anchor-path` for the file it diffs; the click
  // happens inside .diff-file-body rather than .file-content-body. Code-nav must
  // still open. state.fileContent here is a *different* file the user happens to
  // have viewed in the Files tab; openCodeNav must not feed its content to the
  // heuristic as if it were the clicked file's source.
  state.selected = null; // no session → server provider declines, heuristic answers
  state.fileContent = { path: "lib/other.js", content: "function unrelated() {}\n" };
  state.selectedFilePath = "lib/other.js";
  state.codeNav = null;

  onDetailBodyClick(identTokenClick("greet", "lib/app.js", 2, ".diff-file-body"));
  expect(state.codeNav?.symbol).toBe("greet");
  expect(state.codeNav?.path).toBe("lib/app.js");
  expect(state.codeNav?.definitionsStatus).toBe("loading");

  await new Promise(r => setTimeout(r, 5));
  expect(state.codeNav?.definitionsStatus).toBe("done");
  // No matching sourceText for lib/app.js → heuristic finds no declarations.
  // The wrong file's content (lib/other.js) must not leak in as a false match.
  expect(state.codeNav?.definitions).toEqual([]);
  expect(state.codeNav?.referencesStatus).toBe("done");

  closeCodeNav();
});

// A click on an element carrying a single boolean data-* hook (the Files-tab
// editor buttons). closest() matches only that exact attribute selector.
function attrClick(attr: string) {
  return { target: { closest: (sel: string) => (sel === `[${attr}]` ? {} : null) } };
}







test("the Files-tab delete button deletes the open file", async () => {
  const before = deleteFileCalls.length;
  state.selectedFilePath = "src/doomed.ts";
  onDetailBodyClick(attrClick("data-file-delete"));
  await new Promise(r => setTimeout(r, 5));
  expect(deleteFileCalls.slice(before)).toEqual(["src/doomed.ts"]);
});















test("clicking a feedback anchor chip routes to gotoAnchorTarget", async () => {
  state.diff = "diff --git a/src/bar.ts b/src/bar.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n";
  state.collapsedFiles = new Set();
  state.activeTab = "reports";
  state.pendingScrollTo = null;

  onDetailBodyClick(gotoAnchorClick("src/bar.ts", 1, 1));
  await new Promise(resolve => setTimeout(resolve, 10));  // gotoAnchorTarget is async

  expect(state.activeTab).toBe("diff");
  expect(state.pendingScrollTo).toEqual({ anchor: { path: "src/bar.ts", lineStart: 1, lineEnd: 1 } });
});

function diffDirToggleClick(path: string) {
  const row = { getAttribute: (a: string) => (a === "data-diff-dir-toggle" ? path : null) };
  return { target: { closest: (sel: string) => (sel === "[data-diff-dir-toggle]" ? row : null) } };
}

function diffFileJumpClick(path: string) {
  const row = { getAttribute: (a: string) => (a === "data-diff-file-jump" ? path : null) };
  return { target: { closest: (sel: string) => (sel === "[data-diff-file-jump]" ? row : null) } };
}






test("clicking a report's reply-link chip routes to the referenced feedback", async () => {
  state.feedbackHistory = [{ filename: "002-feedback.md", content: "x", status: "read" }];
  state.feedbackToggle = new Map();
  state.activeTab = "reports";
  state.pendingScrollTo = null;
  const chip = { getAttribute: (a) => (a === "data-goto-feedback" ? "002-feedback.md" : null) };
  const event = { target: { closest: (sel) => (sel === "[data-goto-feedback]" ? chip : null) } };

  onDetailBodyClick(event);
  await new Promise(resolve => setTimeout(resolve, 10));

  expect(state.activeTab).toBe("feedback");
  expect(state.pendingScrollTo).toEqual({ article: { attr: "data-feedback-filename", value: "002-feedback.md" } });
});




test("leaving the striped line toward neither the line, the pin, nor the popover hides the pin after the debounce", async () => {
  state.feedbackHistory = [{ filename: "003-anchored.md", content: "x", status: "read" }];
  state.reports = [];
  onDetailBodyPointerOver(overEvent(strikedLine("003-anchored.md")));
  expect(state.feedbackPinAt).not.toBeNull();

  onDetailBodyPointerOut({ target: { closest: (sel: string) => (sel === "[data-feedback-preview]" ? strikedLine("003-anchored.md") : null) }, relatedTarget: null });
  expect(state.feedbackPinAt).not.toBeNull(); // still shown: hide is debounced
  await new Promise(resolve => setTimeout(resolve, 260));
  expect(state.feedbackPinAt).toBeNull();

  hideFeedbackPin();
});





















// onArchive talks to the server with fetch (not api()) so it can read the
// 409 body's `error` field; these tests stand up a fake fetch that records
// every URL and returns canned responses keyed off the request URL.
function installArchiveFetch(steps: Array<{ status: number; body?: unknown }>) {
  const urls: string[] = [];
  let i = 0;
  const fake = (url: string) => {
    urls.push(url);
    const step = steps[i++] ?? steps[steps.length - 1];
    return Promise.resolve({
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.body ?? {},
      text: async () => JSON.stringify(step.body ?? {}),
    });
  };
  const savedFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = fake;
  return { urls, restore: () => { (globalThis as unknown as { fetch: unknown }).fetch = savedFetch; } };
}






// --- attachments ----------------------------------------------------------

// Build a File-like object that addAttachmentFiles can validate. Real File
// constructors work in Bun too, but going through the constructor allocates
// the bytes and slows the test for nothing — only `name`, `type`, `size` are
// read by the validation path, plus identity in the chip rendering.
function fakeFile(name: string, type: string, size: number) {
  return { name, type, size } as unknown as File;
}

// Reject paths in addAttachmentFiles fire toast(), which does
// document.querySelector("#toast"). The other test files manage their own
// document fakes, so install one only for the duration of the callback.
async function withFakeDocument<T>(fn: () => T | Promise<T>): Promise<T> {
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  const saved = globalThis.document;
  globalThis.document = {
    querySelector: () => toastEl,
  } as unknown as Document;
  try {
    return await fn();
  } finally {
    globalThis.document = saved;
  }
}










// Wraps a test that needs a custom api() mock. The top-level mock above stays
// the default; this temporarily swaps in a per-test impl, then restores it.
// `mock.module` itself doesn't return a restore handle, so we re-mock with the
// default afterwards.
async function withApiMock(
  apiImpl: (method: string, path: string, body?: unknown) => Promise<unknown>,
  body: () => Promise<void>,
  overrides: Partial<{
    refreshDetail: () => Promise<void>;
    fetchSessions: () => Promise<void>;
    submitFeedback: (sessionId: string, payload: unknown, attachments: unknown) => Promise<unknown>;
  }> = {},
) {
  const refreshDetail = overrides.refreshDetail ?? (async () => {});
  const fetchSessions = overrides.fetchSessions ?? (async () => { fetchSessionsCalls++; });
  const submitFeedback = overrides.submitFeedback ?? (async (sessionId: string, payload: unknown, attachments: unknown) => {
    submitFeedbackCalls.push({ sessionId, payload, attachments });
    return { filename: "001-x.md", seq: 1 };
  });
  mock.module("../web/api.js", () => ({
    api: apiImpl,
    submitFeedback,
    resolveEscalation: async (sessionId: string, filename: string, payload: unknown, attachments: unknown) => {
      resolveEscalationCalls.push({ sessionId, filename, payload, attachments });
      return { ok: true, answerFilename: "001-answer.md" };
    },
    fetchSessions,
    fetchArchivedSessions: async () => { fetchArchivedSessionsCalls++; },
    fetchActions: async () => {},
    reorderSessions: async (ids: string[]) => { reorderSessionsCalls.push(ids); },
    refreshDetail,
    loadPrLink: async () => {},
    refreshDiff: async () => {},
    ensureFilesLoaded: async () => {},
    ensureStructureLoaded: async () => {},
    ensureStructureBeforeLoaded: async () => {},
    ensureCallGraphLoaded: async () => {},
    ensureCallGraphBeforeLoaded: async () => {},
    ensureStructureViewLoaded: async () => {},
    selectFile: async () => {},
    searchFiles: async () => ({ matches: [], truncated: false }),
    fetchCodeNavLocations: async () => ({ available: false }),
    openWs() {},
  }));
  try {
    await body();
  } finally {
    mock.module("../web/api.js", () => ({
      api: async (method: string, path: string, body?: unknown) => { apiCalls.push({ method, path, body }); return {}; },
      submitFeedback: async (sessionId: string, payload: unknown, attachments: unknown) => {
        submitFeedbackCalls.push({ sessionId, payload, attachments });
        return { filename: "001-x.md", seq: 1 };
      },
      resolveEscalation: async (sessionId: string, filename: string, payload: unknown, attachments: unknown) => {
        resolveEscalationCalls.push({ sessionId, filename, payload, attachments });
        return { ok: true, answerFilename: "001-answer.md" };
      },
      fetchSessions: async () => { fetchSessionsCalls++; },
      fetchArchivedSessions: async () => { fetchArchivedSessionsCalls++; },
      fetchActions: async () => {},
      reorderSessions: async (ids: string[]) => { reorderSessionsCalls.push(ids); },
      refreshDetail: async () => {},
      loadPrLink: async () => {},
      refreshDiff: async () => {},
      ensureFilesLoaded: async () => {},
      ensureStructureLoaded: async () => {},
      ensureStructureBeforeLoaded: async () => {},
      ensureCallGraphLoaded: async () => {},
      ensureCallGraphBeforeLoaded: async () => {},
      ensureStructureViewLoaded: async () => {},
      selectFile: async () => {},
      searchFiles: async () => ({ matches: [], truncated: false }),
      fetchCodeNavLocations: async () => ({ available: false }),
      openWs() {},
    }));
  }
}






// The /resume POST returns; the host has just respawned, and the follow-up
// refreshDetail / fetchSessions occasionally lose the race against that
// transition. Those failures must not drag the captured prompt back into the
// textarea — the resume itself succeeded, and putting the text back makes the
// human think the cleared composer regressed.


// Submitting feedback writes a feedback_received event that the session's
// WebSocket replays as a refreshDetail-driven re-render. A clear that ran
// after the submit await could be stranded by that re-render, leaving the
// already-sent text in the composer — the same race fixed for the resume
// prompt. The clear must happen before the await.


// refreshDetail occasionally loses the race against the events the submit just
// produced. That failure must not drag the text back — the feedback was sent.








test("clicking data-feedback-delete routes to onFeedbackDelete", async () => {
  state.selected = "session-fd";
  state.feedbackHistory = [{ filename: "002-feedback.md", content: "x", status: "read" }];
  state.feedbackToggle = new Map();

  const savedConfirm = globalThis.confirm;
  (globalThis as unknown as { confirm: unknown }).confirm = () => true;

  try {
    await withApiMock(async () => ({ ok: true, filename: "002-feedback.md" }), async () => {
      const btn = { getAttribute: (a: string) => (a === "data-feedback-delete" ? "002-feedback.md" : null) };
      const event = {
        target: { closest: (sel: string) => (sel === "[data-feedback-delete]" ? btn : null) },
        stopPropagation: () => {},
      };
      onDetailBodyClick(event);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  } finally {
    (globalThis as unknown as { confirm: unknown }).confirm = savedConfirm;
  }
});

// --- asking (escalation) attachments -----------------------------------------







