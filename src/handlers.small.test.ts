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

// Fake DOM target whose `closest(sel)` resolves only the selectors listed in
// `ancestors`. Mirrors the way real `Element#closest` walks the DOM tree.
function targetIn(ancestors: string[]) {
  return {
    closest: (sel: string) => (ancestors.includes(sel) ? {} : null),
  };
}

test("onAnchorOutsideClick clears the anchor when the click target sits outside the floating composer", () => {
  state.anchor = { path: "lib/app.js", lineStart: 1, lineEnd: 1 };

  onAnchorOutsideClick(targetIn([]));

  expect(state.anchor).toBeNull();
});

test("onAnchorOutsideClick keeps the anchor when the click is inside the floating composer", () => {
  state.anchor = { path: "lib/app.js", lineStart: 1, lineEnd: 1 };

  onAnchorOutsideClick(targetIn([".anchored-composer"]));

  expect(state.anchor).toEqual({ path: "lib/app.js", lineStart: 1, lineEnd: 1 });
});

test("onAnchorOutsideClick keeps the anchor when the click is inside the bottom composer (the chip's permalink/×, or the bottom textarea, share the same anchor)", () => {
  state.anchor = { path: "lib/app.js", lineStart: 1, lineEnd: 1 };

  onAnchorOutsideClick(targetIn([".feedback-form"]));

  expect(state.anchor).not.toBeNull();
});

test("onAnchorOutsideClick keeps the anchor when the click lands on another anchorable line (the line click handler will reset it)", () => {
  state.anchor = { path: "lib/app.js", lineStart: 1, lineEnd: 1 };

  onAnchorOutsideClick(targetIn(["[data-anchor-line]"]));

  expect(state.anchor).not.toBeNull();
});

test("onAnchorOutsideClick is a no-op when there is no anchor", () => {
  state.anchor = null;

  onAnchorOutsideClick(targetIn([]));

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



// A click on an element carrying a single boolean data-* hook (the Files-tab
// editor buttons). closest() matches only that exact attribute selector.
function attrClick(attr: string) {
  return { target: { closest: (sel: string) => (sel === `[${attr}]` ? {} : null) } };
}

test("the Files-tab edit button opens the editor seeded with the open file's text", () => {
  state.fileContent = { path: "src/a.ts", content: "alpha\nbeta\n" };
  state.selectedFilePath = "src/a.ts";
  state.fileEditing = false;
  state.fileEditDraft = "";

  onDetailBodyClick(attrClick("data-file-edit"));
  expect(state.fileEditing).toBe(true);
  expect(state.fileEditDraft).toBe("alpha\nbeta\n");
});

test("the Files-tab cancel button leaves edit mode without saving", () => {
  const before = saveFileCalls;
  state.fileEditing = true;
  onDetailBodyClick(attrClick("data-file-edit-cancel"));
  expect(state.fileEditing).toBe(false);
  expect(saveFileCalls).toBe(before);
});

test("the Files-tab save button calls saveFile", () => {
  const before = saveFileCalls;
  onDetailBodyClick(attrClick("data-file-edit-save"));
  expect(saveFileCalls).toBe(before + 1);
});

test("the Files-tab new-file button opens a fresh path input", () => {
  state.fileCreating = false;
  state.fileNewPath = "stale";
  onDetailBodyClick(attrClick("data-file-new"));
  expect(state.fileCreating).toBe(true);
  expect(state.fileNewPath).toBe("");
});

test("the Files-tab new-file confirm button calls createFile with the typed path", () => {
  const before = createFileCalls.length;
  state.fileNewPath = "src/new.ts";
  onDetailBodyClick(attrClick("data-file-new-confirm"));
  expect(createFileCalls.slice(before)).toEqual(["src/new.ts"]);
});

test("the Files-tab new-file cancel button closes the path input", () => {
  state.fileCreating = true;
  onDetailBodyClick(attrClick("data-file-new-cancel"));
  expect(state.fileCreating).toBe(false);
});


test("the Files-tab rename button opens the rename input seeded with the open file's path", () => {
  state.selectedFilePath = "src/old.ts";
  state.fileRenaming = false;
  state.fileRenamePath = "";
  onDetailBodyClick(attrClick("data-file-rename"));
  expect(state.fileRenaming).toBe(true);
  expect(state.fileRenamePath).toBe("src/old.ts");
});

test("the Files-tab rename confirm button calls renameFile with the typed path", () => {
  const before = renameFileCalls.length;
  state.fileRenamePath = "src/renamed.ts";
  onDetailBodyClick(attrClick("data-file-rename-confirm"));
  expect(renameFileCalls.slice(before)).toEqual(["src/renamed.ts"]);
});

test("the Files-tab rename cancel button closes the rename input", () => {
  state.fileRenaming = true;
  onDetailBodyClick(attrClick("data-file-rename-cancel"));
  expect(state.fileRenaming).toBe(false);
});

test("command-result feedback is expanded only until the agent consumes it", () => {
  state.feedbackToggle = new Map();
  // Right after the run the feedback is still unread → shown.
  expect(isFeedbackExpanded({ filename: "012-command-approve.md", status: "unread" })).toBe(true);
  // Once the agent fetches it (e.g. after a reload) it collapses.
  expect(isFeedbackExpanded({ filename: "012-command-approve.md", status: "read" })).toBe(false);
  // An explicit toggle still wins.
  state.feedbackToggle = new Map([["012-command-approve.md", true]]);
  expect(isFeedbackExpanded({ filename: "012-command-approve.md", status: "read" })).toBe(true);
});

test("revealReport switches to a different session, opens the Reports tab, and expands the report", async () => {
  state.selected = "session-a";
  state.activeTab = "diff";
  state.reportToggle = new Map();

  await revealReport("session-b", "003-build-failed.md");

  expect(state.selected).toBe("session-b");
  expect(state.activeTab).toBe("reports");
  expect(state.reportToggle.get("003-build-failed.md")).toBe(true);
});

test("revealReport without a filename still brings the session's Reports tab into view", async () => {
  state.selected = "session-a";
  state.activeTab = "files";

  await revealReport("session-a", null);

  expect(state.selected).toBe("session-a");
  expect(state.activeTab).toBe("reports");
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

test("an idempotent action whose request is severed mid-flight (serve --watch restart) retries once the server is back", async () => {
  // Reproduces the merge-to-base symptom: `git merge` rewrites the dev
  // server's own source, `bun --watch` restarts it, this POST's socket dies
  // before the response. The merge already landed on disk, so re-issuing the
  // request once the rebound server answers reports the real (success) result.
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  const saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  globalThis.document = { getElementById: () => null, querySelector: () => toastEl };
  globalThis.window = { open() {} };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return { json: async () => ({ ok: true, exitCode: 0, stdout: "Already up to date.", stderr: "" }) };
  };
  try {
    state.selected = "session-a";
    state.actions = [{ id: "merge-to-base", label: "📤 Merge into base branch", params: [], idempotent: true }];
    state.openActionId = "merge-to-base";
    state.actionResults = new Map();
    state.actionRunInFlight = false;

    await runOpenAction();

    expect(calls).toBe(2);
    expect(state.actionResults.get("merge-to-base").ok).toBe(true);
    expect(state.actionRunInFlight).toBe(false);
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  }
});

test("a non-idempotent action whose request fails is recorded as failed without retrying", async () => {
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  const saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  globalThis.document = { getElementById: () => null, querySelector: () => toastEl };
  globalThis.window = { open() {} };
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("Failed to fetch"); };
  try {
    state.selected = "session-a";
    state.actions = [{ id: "create-pr", label: "Create PR", params: [] }];
    state.openActionId = "create-pr";
    state.actionResults = new Map();
    state.actionRunInFlight = false;

    await runOpenAction();

    expect(calls).toBe(1);
    expect(state.actionResults.get("create-pr").ok).toBe(false);
    expect(state.actionRunInFlight).toBe(false);
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  }
});

test("create-pr opens a tab synchronously and points it at the PR URL", async () => {
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  const saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  globalThis.document = { getElementById: () => null, querySelector: () => toastEl };
  const prTab = { location: "about:blank", opener: {}, closed: false, close() { this.closed = true; } };
  const openCalls: Array<{ url: string; target: string }> = [];
  globalThis.window = { open(url, target) { openCalls.push({ url, target }); return prTab; } };
  const log = "$ gh pr create --base main --head worqload/abc\nhttps://github.com/kesompochy/worqload/pull/7";
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, exitCode: 0, stdout: log, stderr: "" }) });
  try {
    state.selected = "session-a";
    state.actions = [{ id: "create-pr", label: "Create PR", params: [] }];
    state.openActionId = "create-pr";
    state.actionResults = new Map();
    state.actionRunInFlight = false;

    await runOpenAction();

    // The tab is opened blank (the only window.open call), so it lands inside
    // the click's user gesture; the PR URL is assigned to it afterwards.
    expect(openCalls).toEqual([{ url: "", target: "_blank" }]);
    expect(prTab.location).toBe("https://github.com/kesompochy/worqload/pull/7");
    expect(prTab.closed).toBe(false);
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  }
});

test("create-pr closes the pre-opened tab when the run fails", async () => {
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  const saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  globalThis.document = { getElementById: () => null, querySelector: () => toastEl };
  const prTab = { location: "about:blank", opener: {}, closed: false, close() { this.closed = true; } };
  globalThis.window = { open() { return prTab; } };
  globalThis.fetch = async () => ({ json: async () => ({ ok: false, exitCode: 1, stdout: "", stderr: "push rejected" }) });
  try {
    state.selected = "session-a";
    state.actions = [{ id: "create-pr", label: "Create PR", params: [] }];
    state.openActionId = "create-pr";
    state.actionResults = new Map();
    state.actionRunInFlight = false;

    await runOpenAction();

    expect(prTab.closed).toBe(true);
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  }
});

test("gotoAnchorTarget opens the Reports tab and expands the referenced report", async () => {
  state.reports = [{ filename: "003-progress.md", content: "x", read: true }];
  state.reportToggle = new Map();
  state.activeTab = "diff";
  state.pendingScrollTo = null;

  await gotoAnchorTarget("./.worqload-reports/003-progress.md", 5, 7);

  expect(state.activeTab).toBe("reports");
  expect(state.reportToggle.get("003-progress.md")).toBe(true);
  expect(state.pendingScrollTo).toEqual({ anchor: { path: "./.worqload-reports/003-progress.md", lineStart: 5, lineEnd: 7 } });
});

test("gotoAnchorTarget opens the Diff tab and un-collapses the anchored file", async () => {
  state.diff = "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n";
  state.collapsedFiles = new Set(["src/foo.ts"]);
  state.activeTab = "reports";
  state.pendingScrollTo = null;

  await gotoAnchorTarget("src/foo.ts", 1, 1);

  expect(state.activeTab).toBe("diff");
  expect(state.collapsedFiles.has("src/foo.ts")).toBe(false);
  expect(state.pendingScrollTo).toEqual({ anchor: { path: "src/foo.ts", lineStart: 1, lineEnd: 1 } });
});


function diffDirToggleClick(path: string) {
  const row = { getAttribute: (a: string) => (a === "data-diff-dir-toggle" ? path : null) };
  return { target: { closest: (sel: string) => (sel === "[data-diff-dir-toggle]" ? row : null) } };
}

function diffFileJumpClick(path: string) {
  const row = { getAttribute: (a: string) => (a === "data-diff-file-jump" ? path : null) };
  return { target: { closest: (sel: string) => (sel === "[data-diff-file-jump]" ? row : null) } };
}

test("clicking a directory row in the Diff tree toggles its collapse with a fresh Set", () => {
  state.diffTreeCollapsed = new Set();
  const before = state.diffTreeCollapsed;

  onDetailBodyClick(diffDirToggleClick("src"));
  expect(state.diffTreeCollapsed).not.toBe(before);
  expect(state.diffTreeCollapsed.has("src")).toBe(true);

  onDetailBodyClick(diffDirToggleClick("src"));
  expect(state.diffTreeCollapsed.has("src")).toBe(false);
});

test("clicking a file row in the Diff tree un-collapses the diff-file and queues an instant scroll to it", () => {
  state.collapsedFiles = new Set(["src/foo.ts"]);
  state.pendingScrollTo = null;

  onDetailBodyClick(diffFileJumpClick("src/foo.ts"));

  expect(state.collapsedFiles.has("src/foo.ts")).toBe(false);
  // `instant: true` makes DetailBody scroll with behavior: "auto" instead of
  // "smooth" — a deliberate file pick doesn't need the orienting animation.
  expect(state.pendingScrollTo).toEqual({ article: { attr: "data-diff-path", value: "src/foo.ts" }, instant: true });
});

test("selectSession resets the Diff tab's directory collapse state", async () => {
  state.diffTreeCollapsed = new Set(["src"]);

  await selectSession("session-x");

  expect(state.diffTreeCollapsed.size).toBe(0);
});

test("gotoAnchorTarget falls back to the Files tab when the path is not in the diff", async () => {
  state.diff = "";  // path is not part of the diff
  state.files = ["src/util.ts"];
  state.activeTab = "reports";
  state.pendingScrollTo = null;

  await gotoAnchorTarget("src/util.ts", 9, 9);

  expect(state.activeTab).toBe("files");
  expect(state.pendingScrollTo).toEqual({ anchor: { path: "src/util.ts", lineStart: 9, lineEnd: 9 } });
});

test("gotoArticle opens the Feedback tab, expands the feedback, and queues a scroll to its card", async () => {
  state.feedbackHistory = [{ filename: "004-feedback.md", content: "x", status: "read" }];
  state.feedbackToggle = new Map();
  state.activeTab = "reports";
  state.pendingScrollTo = null;

  await gotoArticle("feedback", "004-feedback.md");

  expect(state.activeTab).toBe("feedback");
  expect(state.feedbackToggle.get("004-feedback.md")).toBe(true);
  expect(state.pendingScrollTo).toEqual({ article: { attr: "data-feedback-filename", value: "004-feedback.md" } });
});


test("hovering a striped anchored line drops the 💬 pin at the pointer", () => {
  state.feedbackHistory = [
    { filename: "003-anchored.md", content: "looks off here", status: "read", anchor: { path: "src/a.ts", lineStart: 4, lineEnd: 4 } },
    { filename: "002-feedback.md", content: "unrelated", status: "read" },
  ];
  state.reports = [];
  state.feedbackPinAt = null;

  onDetailBodyPointerOver(overEvent(strikedLine("003-anchored.md"), 120, 240));

  expect(state.feedbackPinAt).toEqual({ key: "003-anchored.md", filenames: ["003-anchored.md"], x: 120, y: 240 });
});

test("moving within the same striped line keeps the pin where it first landed", () => {
  state.feedbackHistory = [{ filename: "003-anchored.md", content: "x", status: "read" }];
  state.reports = [];
  state.feedbackPinAt = null;

  onDetailBodyPointerOver(overEvent(strikedLine("003-anchored.md"), 120, 240));
  onDetailBodyPointerOver(overEvent(strikedLine("003-anchored.md"), 180, 250));

  expect(state.feedbackPinAt).toEqual({ key: "003-anchored.md", filenames: ["003-anchored.md"], x: 120, y: 240 });
});

test("a striped line naming an unknown feedback drops no pin", () => {
  state.feedbackHistory = [];
  state.reports = [];
  state.feedbackPinAt = null;
  onDetailBodyPointerOver(overEvent(strikedLine("404-gone.md")));
  expect(state.feedbackPinAt).toBeNull();
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

test("selectSession writes the new session id into the URL", async () => {
  const win = installUrlWindow("");
  state.activeTab = "reports";
  try {
    await selectSession("session-c");
    expect(win.lastUrl).toBe("/?session=session-c");
  } finally {
    uninstallUrlWindow();
  }
});

test("switchTab writes the new tab into the URL (default tab is omitted)", async () => {
  const win = installUrlWindow("?session=session-c");
  state.selected = "session-c";
  state.activeTab = "reports";
  try {
    await switchTab("diff");
    expect(win.lastUrl).toBe("/?session=session-c&tab=diff");
    await switchTab("reports");
    expect(win.lastUrl).toBe("/?session=session-c");
  } finally {
    uninstallUrlWindow();
  }
});

test("pushStructureFocus drills the focus stack and appends a focus query param per level", async () => {
  const win = installUrlWindow("?session=session-c&tab=structure");
  state.selected = "session-c";
  state.activeTab = "structure";
  state.structureFocusStack = [];
  try {
    pushStructureFocus("src/a.ts");
    expect(state.structureFocusStack).toEqual(["src/a.ts"]);
    expect(win.lastUrl).toBe("/?session=session-c&tab=structure&focus=src%2Fa.ts");
    pushStructureFocus("src/b.ts");
    expect(state.structureFocusStack).toEqual(["src/a.ts", "src/b.ts"]);
    expect(win.lastUrl).toBe("/?session=session-c&tab=structure&focus=src%2Fa.ts&focus=src%2Fb.ts");
  } finally {
    uninstallUrlWindow();
  }
});

test("pushStructureFocus is a no-op when the path is already on top", async () => {
  const win = installUrlWindow("?session=session-c&tab=structure&focus=src%2Fa.ts");
  state.selected = "session-c";
  state.activeTab = "structure";
  state.structureFocusStack = ["src/a.ts"];
  const before = win.pushCount;
  try {
    pushStructureFocus("src/a.ts");
    expect(state.structureFocusStack).toEqual(["src/a.ts"]);
    expect(win.pushCount).toBe(before);
  } finally {
    uninstallUrlWindow();
  }
});

test("popStructureFocus walks one level back and rewrites the URL", async () => {
  const win = installUrlWindow("?session=session-c&tab=structure&focus=src%2Fa.ts&focus=src%2Fb.ts");
  state.selected = "session-c";
  state.activeTab = "structure";
  state.structureFocusStack = ["src/a.ts", "src/b.ts"];
  try {
    popStructureFocus();
    expect(state.structureFocusStack).toEqual(["src/a.ts"]);
    expect(win.lastUrl).toBe("/?session=session-c&tab=structure&focus=src%2Fa.ts");
    popStructureFocus();
    expect(state.structureFocusStack).toEqual([]);
    expect(win.lastUrl).toBe("/?session=session-c&tab=structure");
  } finally {
    uninstallUrlWindow();
  }
});

test("clearStructureFocus empties the stack in one history entry", async () => {
  const win = installUrlWindow("?session=session-c&tab=structure&focus=src%2Fa.ts&focus=src%2Fb.ts");
  state.selected = "session-c";
  state.activeTab = "structure";
  state.structureFocusStack = ["src/a.ts", "src/b.ts"];
  const before = win.pushCount;
  try {
    clearStructureFocus();
    expect(state.structureFocusStack).toEqual([]);
    expect(win.lastUrl).toBe("/?session=session-c&tab=structure");
    expect(win.pushCount).toBe(before + 1);
  } finally {
    uninstallUrlWindow();
  }
});

test("applyUrlState restores session, tab, and focus stack without pushing further history", async () => {
  const win = installUrlWindow("?session=session-c&tab=structure&focus=src%2Fa.ts");
  state.selected = "session-a";
  state.activeTab = "reports";
  state.structureFocusStack = [];
  try {
    await applyUrlState({ sessionId: "session-c", tab: "structure", focusStack: ["src/a.ts"] });
    expect(state.selected).toBe("session-c");
    expect(state.activeTab).toBe("structure");
    expect(state.structureFocusStack).toEqual(["src/a.ts"]);
    expect(win.pushCount).toBe(0);
  } finally {
    uninstallUrlWindow();
  }
});

test("onSidebarTab flips to the archived feed and pulls it from the server", async () => {
  state.sidebarTab = "active";
  fetchArchivedSessionsCalls = 0;
  fetchSessionsCalls = 0;

  await onSidebarTab("archived");

  expect(state.sidebarTab).toBe("archived");
  expect(fetchArchivedSessionsCalls).toBe(1);
  expect(fetchSessionsCalls).toBe(0);

  // Flipping back refreshes the active list, not the archived one.
  await onSidebarTab("active");
  expect(state.sidebarTab).toBe("active");
  expect(fetchSessionsCalls).toBe(1);
  expect(fetchArchivedSessionsCalls).toBe(1);
});

test("toggleSidebar flips state.sidebarHidden and persists the new value to localStorage", () => {
  state.sidebarHidden = false;
  const writes: Array<[string, string]> = [];
  const savedLocalStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage;
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    setItem: (k: string, v: string) => { writes.push([k, v]); },
  };
  try {
    toggleSidebar();
    expect(state.sidebarHidden).toBe(true);
    expect(writes).toEqual([["worqload:sidebar-hidden", "1"]]);

    toggleSidebar();
    expect(state.sidebarHidden).toBe(false);
    expect(writes[1]).toEqual(["worqload:sidebar-hidden", "0"]);
  } finally {
    if (savedLocalStorage === undefined) delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    else (globalThis as unknown as { localStorage: unknown }).localStorage = savedLocalStorage;
  }
});

test("onSidebarTab does nothing when the requested tab is already shown", async () => {
  state.sidebarTab = "active";
  fetchSessionsCalls = 0;
  fetchArchivedSessionsCalls = 0;

  await onSidebarTab("active");

  expect(fetchSessionsCalls).toBe(0);
  expect(fetchArchivedSessionsCalls).toBe(0);
});

test("onDeleteArchived confirms, calls DELETE /sessions/:id, and reloads the archived feed", async () => {
  state.sidebarTab = "archived";
  state.archivedSessions = [{ id: "arc-1", title: "old session" }];
  state.selected = "arc-1";
  apiCalls.length = 0;
  fetchArchivedSessionsCalls = 0;

  const savedWindow = globalThis.window;
  let confirmCalledWith: string | undefined;
  (globalThis as unknown as { window: unknown }).window = { confirm: (m: string) => { confirmCalledWith = m; return true; } };

  try {
    await onDeleteArchived("arc-1");
  } finally {
    (globalThis as unknown as { window: unknown }).window = savedWindow;
  }

  expect(confirmCalledWith).toContain("old session");
  expect(apiCalls).toEqual([{ method: "DELETE", path: "/sessions/arc-1", body: undefined }]);
  expect(fetchArchivedSessionsCalls).toBe(1);
  // The deleted session was the selected one; selection clears so the detail
  // pane stops trying to show data that no longer exists.
  expect(state.selected).toBeNull();
});

test("onDeleteArchived bails when the human cancels the confirm dialog", async () => {
  state.archivedSessions = [{ id: "arc-2", title: "x" }];
  apiCalls.length = 0;
  fetchArchivedSessionsCalls = 0;

  const savedWindow = globalThis.window;
  (globalThis as unknown as { window: unknown }).window = { confirm: () => false };

  try {
    await onDeleteArchived("arc-2");
  } finally {
    (globalThis as unknown as { window: unknown }).window = savedWindow;
  }

  expect(apiCalls).toEqual([]);
  expect(fetchArchivedSessionsCalls).toBe(0);
});

test("onToggleArchivedSelection toggles ids on a fresh Set so Svelte re-renders", () => {
  state.archivedSelection = new Set();
  const before = state.archivedSelection;

  onToggleArchivedSelection("arc-1");
  expect(state.archivedSelection).not.toBe(before);
  expect(state.archivedSelection.has("arc-1")).toBe(true);

  onToggleArchivedSelection("arc-2");
  expect([...state.archivedSelection].sort()).toEqual(["arc-1", "arc-2"]);

  onToggleArchivedSelection("arc-1");
  expect([...state.archivedSelection]).toEqual(["arc-2"]);
});

test("onSelectAllArchived picks every id in the archived feed; Clear empties the selection", () => {
  state.archivedSessions = [{ id: "arc-1" }, { id: "arc-2" }, { id: "arc-3" }];
  state.archivedSelection = new Set();

  onSelectAllArchived();
  expect([...state.archivedSelection].sort()).toEqual(["arc-1", "arc-2", "arc-3"]);

  onClearArchivedSelection();
  expect(state.archivedSelection.size).toBe(0);
});

test("leaving the archived tab drops the bulk-delete selection", async () => {
  state.sidebarTab = "archived";
  state.archivedSelection = new Set(["arc-1", "arc-2"]);

  await onSidebarTab("active");

  expect(state.sidebarTab).toBe("active");
  expect(state.archivedSelection.size).toBe(0);
});

test("onBulkDeleteArchived DELETEs every selected id in turn, reloads the feed, and clears the selection", async () => {
  state.archivedSessions = [{ id: "arc-1" }, { id: "arc-2" }, { id: "arc-3" }];
  state.archivedSelection = new Set(["arc-1", "arc-3"]);
  state.selected = "arc-1";
  apiCalls.length = 0;
  fetchArchivedSessionsCalls = 0;

  const savedWindow = globalThis.window;
  (globalThis as unknown as { window: unknown }).window = { confirm: () => true };
  // onBulkDeleteArchived's outcome toast reads through document.querySelector.
  const savedDocument = globalThis.document;
  globalThis.document = { querySelector: () => ({ textContent: "", classList: { add() {}, remove() {} } }) } as unknown as Document;

  try {
    await onBulkDeleteArchived();
  } finally {
    (globalThis as unknown as { window: unknown }).window = savedWindow;
    globalThis.document = savedDocument;
  }

  // DELETEs sent for arc-1 and arc-3 (sequential, not arc-2).
  const deletes = apiCalls.filter(c => c.method === "DELETE").map(c => c.path).sort();
  expect(deletes).toEqual(["/sessions/arc-1", "/sessions/arc-3"]);
  expect(state.archivedSelection.size).toBe(0);
  expect(fetchArchivedSessionsCalls).toBe(1);
  // arc-1 was the selected session in the detail pane; clearing it stops the
  // pane from showing data the server just removed.
  expect(state.selected).toBeNull();
});

test("onBulkDeleteArchived asks confirm once and bails when the human cancels", async () => {
  state.archivedSelection = new Set(["arc-1", "arc-2"]);
  apiCalls.length = 0;
  fetchArchivedSessionsCalls = 0;

  const savedWindow = globalThis.window;
  let confirmCalls = 0;
  (globalThis as unknown as { window: unknown }).window = { confirm: () => { confirmCalls++; return false; } };

  try {
    await onBulkDeleteArchived();
  } finally {
    (globalThis as unknown as { window: unknown }).window = savedWindow;
  }

  expect(confirmCalls).toBe(1);
  expect(apiCalls.filter(c => c.method === "DELETE")).toEqual([]);
  expect(fetchArchivedSessionsCalls).toBe(0);
  expect(state.archivedSelection.size).toBe(2);
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

test("onArchive POSTs straight to /archive when the server doesn't flag a running preview", async () => {
  state.sessions = [{ id: "sess-1" }, { id: "sess-2" }];
  state.selected = "sess-1";
  const { urls, restore } = installArchiveFetch([{ status: 200, body: { meta: { id: "sess-1", archivedAt: "now" } } }]);
  try {
    await onArchive("sess-1");
  } finally {
    restore();
  }
  expect(urls).toEqual(["/sessions/sess-1/archive"]);
});

test("onArchive surfaces the running preview, confirms, then retries with stopPreview=true on approval", async () => {
  state.sessions = [{ id: "sess-1" }];
  state.selected = "sess-1";
  const { urls, restore } = installArchiveFetch([
    { status: 409, body: { error: "preview-running", pid: 4242, url: "http://127.0.0.1:3501" } },
    { status: 200, body: { meta: { id: "sess-1", archivedAt: "now" } } },
  ]);
  const savedWindow = globalThis.window;
  let confirmedWith: string | undefined;
  (globalThis as unknown as { window: unknown }).window = { confirm: (m: string) => { confirmedWith = m; return true; } };
  try {
    await onArchive("sess-1");
  } finally {
    restore();
    (globalThis as unknown as { window: unknown }).window = savedWindow;
  }
  expect(confirmedWith).toContain("Preview");
  expect(confirmedWith).toContain("http://127.0.0.1:3501");
  expect(urls).toEqual(["/sessions/sess-1/archive", "/sessions/sess-1/archive?stopPreview=true"]);
});

test("onArchive bails without sending a second request when the human cancels the preview warning", async () => {
  state.sessions = [{ id: "sess-1" }];
  state.selected = "sess-1";
  const { urls, restore } = installArchiveFetch([
    { status: 409, body: { error: "preview-running", pid: 4242, url: null } },
  ]);
  const savedWindow = globalThis.window;
  (globalThis as unknown as { window: unknown }).window = { confirm: () => false };
  try {
    await onArchive("sess-1");
  } finally {
    restore();
    (globalThis as unknown as { window: unknown }).window = savedWindow;
  }
  expect(urls).toEqual(["/sessions/sess-1/archive"]);
});

test("onUnarchive POSTs to /sessions/:id/unarchive, reloads the archived feed, and refreshes the active list", async () => {
  state.sidebarTab = "archived";
  state.archivedSessions = [{ id: "arc-7", title: "restore me" }];
  state.archivedSelection = new Set(["arc-7"]);
  state.selected = null;
  apiCalls.length = 0;
  fetchArchivedSessionsCalls = 0;
  fetchSessionsCalls = 0;

  await onUnarchive("arc-7");

  expect(apiCalls).toEqual([{ method: "POST", path: "/sessions/arc-7/unarchive", body: {} }]);
  expect(fetchArchivedSessionsCalls).toBe(1);
  expect(fetchSessionsCalls).toBe(1);
  // The unarchived id drops out of the bulk-delete selection — its card is
  // about to vanish from the archived feed.
  expect(state.archivedSelection.has("arc-7")).toBe(false);
});

test("onUnarchive bails when called with no id", async () => {
  state.selected = null;
  apiCalls.length = 0;
  fetchArchivedSessionsCalls = 0;
  fetchSessionsCalls = 0;

  await onUnarchive();

  expect(apiCalls).toEqual([]);
  expect(fetchArchivedSessionsCalls).toBe(0);
  expect(fetchSessionsCalls).toBe(0);
});

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

test("addAttachmentFiles accepts allowed image types and stages chips with preview URLs", () => {
  clearAttachments();
  addAttachmentFiles([
    fakeFile("a.png", "image/png", 1234),
    fakeFile("b.webp", "image/webp", 9999),
  ]);
  expect(state.pendingAttachments).toHaveLength(2);
  expect(state.pendingAttachments[0].file.name).toBe("a.png");
  expect(state.pendingAttachments[0].previewUrl).toMatch(/^blob:fake\//);
  expect(state.pendingAttachments[1].file.name).toBe("b.webp");
});

test("addAttachmentFiles skips non-image MIME types", async () => {
  clearAttachments();
  await withFakeDocument(() => {
    addAttachmentFiles([
      fakeFile("doc.pdf", "application/pdf", 100),
      fakeFile("good.png", "image/png", 100),
    ]);
  });
  expect(state.pendingAttachments.map(a => a.file.name)).toEqual(["good.png"]);
});

test("addAttachmentFiles skips files exceeding the byte cap", async () => {
  clearAttachments();
  await withFakeDocument(() => {
    addAttachmentFiles([
      fakeFile("huge.png", "image/png", 11 * 1024 * 1024),  // > 10 MiB cap
      fakeFile("ok.png", "image/png", 100),
    ]);
  });
  expect(state.pendingAttachments.map(a => a.file.name)).toEqual(["ok.png"]);
});

test("addAttachmentFiles stops once the per-feedback count cap is reached", async () => {
  clearAttachments();
  await withFakeDocument(() => {
    addAttachmentFiles(Array.from({ length: 7 }, (_, i) => fakeFile(`img${i}.png`, "image/png", 10)));
  });
  expect(state.pendingAttachments).toHaveLength(5);  // ATTACHMENT_MAX_COUNT
});

test("removeAttachment splices by id and revokes its preview URL", () => {
  clearAttachments();
  revokedObjectURLs.length = 0;
  addAttachmentFiles([
    fakeFile("a.png", "image/png", 1),
    fakeFile("b.png", "image/png", 1),
  ]);
  const idA = state.pendingAttachments[0].id;
  const urlA = state.pendingAttachments[0].previewUrl;

  removeAttachment(idA);

  expect(state.pendingAttachments.map(a => a.file.name)).toEqual(["b.png"]);
  expect(revokedObjectURLs).toEqual([urlA]);
});

test("clearAttachments empties the list and revokes every preview URL", () => {
  clearAttachments();
  revokedObjectURLs.length = 0;
  addAttachmentFiles([
    fakeFile("a.png", "image/png", 1),
    fakeFile("b.png", "image/png", 1),
  ]);
  const urls = state.pendingAttachments.map(a => a.previewUrl);

  clearAttachments();

  expect(state.pendingAttachments).toEqual([]);
  expect(revokedObjectURLs.sort()).toEqual(urls.sort());
});

test("selectSession clears pendingAttachments so they don't leak across sessions", async () => {
  clearAttachments();
  addAttachmentFiles([fakeFile("a.png", "image/png", 1)]);
  expect(state.pendingAttachments).toHaveLength(1);

  await selectSession("session-other");

  expect(state.pendingAttachments).toEqual([]);
});

test("onFeedback hands the textarea text and queued attachments to submitFeedback, then clears both", async () => {
  clearAttachments();
  state.selected = "session-x";
  state.anchor = null;
  state.pendingAttachments = [];
  submitFeedbackCalls.length = 0;

  const inputEl = { value: "look at this" };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : toastEl),
  } as unknown as Document;
  try {
    addAttachmentFiles([fakeFile("a.png", "image/png", 10)]);
    await onFeedback();

    expect(submitFeedbackCalls).toHaveLength(1);
    expect(submitFeedbackCalls[0].sessionId).toBe("session-x");
    expect(submitFeedbackCalls[0].payload).toEqual({ content: "look at this", slug: "feedback" });
    expect((submitFeedbackCalls[0].attachments as unknown[]).length).toBe(1);
    expect(state.pendingAttachments).toEqual([]);
    expect(inputEl.value).toBe("");
  } finally {
    globalThis.document = saved.document;
  }
});

test("onFeedback bails when both the textarea and the attachment list are empty", async () => {
  clearAttachments();
  state.selected = "session-x";
  state.anchor = null;
  submitFeedbackCalls.length = 0;

  const inputEl = { value: "   " };
  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : null),
  } as unknown as Document;
  try {
    await onFeedback();
    expect(submitFeedbackCalls).toEqual([]);
  } finally {
    globalThis.document = saved.document;
  }
});

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

test("onToggleReviseMode flips an off (absent) flag on and POSTs the new value", async () => {
  state.selected = "sess-ra";
  state.detail = { meta: { id: "sess-ra" }, events: [] };
  state.sessions = [{ id: "sess-ra" }];
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];

  await withApiMock(async (method, path, body) => {
    calls.push({ method, path, body });
    return { meta: { id: "sess-ra", reviseModeEnabled: (body as { enabled: boolean }).enabled } };
  }, async () => {
    await onToggleReviseMode("sess-ra");
  });

  expect(calls).toEqual([{ method: "POST", path: "/sessions/sess-ra/revise-mode", body: { enabled: true } }]);
  expect(state.detail.meta.reviseModeEnabled).toBe(true);
  // Sidebar card stays in sync so a later detail reload reflects the same value.
  expect(state.sessions[0].reviseModeEnabled).toBe(true);
});

test("onToggleReviseMode turns the flag back off when it was explicitly on", async () => {
  state.selected = "sess-rb";
  state.detail = { meta: { id: "sess-rb", reviseModeEnabled: true }, events: [] };
  state.sessions = [];
  const bodies: unknown[] = [];

  await withApiMock(async (_method, _path, body) => {
    bodies.push(body);
    return { meta: { id: "sess-rb", reviseModeEnabled: (body as { enabled: boolean }).enabled } };
  }, async () => {
    await onToggleReviseMode("sess-rb");
  });

  expect(bodies).toEqual([{ enabled: false }]);
  expect(state.detail.meta.reviseModeEnabled).toBe(false);
});

test("onResume clears the textarea before the await, so a re-render mid-flight can't strand the prompt", async () => {
  state.selected = "session-r";

  const inputEl = { value: "carry on" };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  let valueWhenApiSeen: string | null = null;
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];

  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : toastEl),
  } as unknown as Document;
  try {
    await withApiMock(async (method, path, body) => {
      calls.push({ method, path, body });
      valueWhenApiSeen = inputEl.value;
      return {};
    }, async () => {
      await onResume();
    });
    expect(calls).toEqual([{ method: "POST", path: "/sessions/session-r/resume", body: { prompt: "carry on" } }]);
    expect(valueWhenApiSeen).toBe("");
    expect(inputEl.value).toBe("");
  } finally {
    globalThis.document = saved.document;
  }
});

test("onResume restores the prompt when the API call fails, so a long message isn't lost", async () => {
  state.selected = "session-r";

  const inputEl = { value: "important note" };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };

  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : toastEl),
  } as unknown as Document;
  try {
    await withApiMock(async () => { throw new Error("boom"); }, async () => {
      await onResume();
    });
    expect(inputEl.value).toBe("important note");
  } finally {
    globalThis.document = saved.document;
  }
});

test("onStopAndResume clears the textarea before the stop/resume awaits", async () => {
  state.selected = "session-s";

  const inputEl = { value: "go again" };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  let valueAtFirstApi: string | null = null;
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];

  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : toastEl),
  } as unknown as Document;
  try {
    await withApiMock(async (method, path, body) => {
      calls.push({ method, path, body });
      if (calls.length === 1) valueAtFirstApi = inputEl.value;
      return {};
    }, async () => {
      await onStopAndResume();
    });
    expect(calls.map(c => c.path)).toEqual([
      "/sessions/session-s/stop",
      "/sessions/session-s/resume",
    ]);
    expect(valueAtFirstApi).toBe("");
    expect(inputEl.value).toBe("");
  } finally {
    globalThis.document = saved.document;
  }
});

// The /resume POST returns; the host has just respawned, and the follow-up
// refreshDetail / fetchSessions occasionally lose the race against that
// transition. Those failures must not drag the captured prompt back into the
// textarea — the resume itself succeeded, and putting the text back makes the
// human think the cleared composer regressed.
test("onResume keeps the textarea cleared when refreshDetail throws after a successful resume POST", async () => {
  state.selected = "session-r";

  const inputEl = { value: "carry on" };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };

  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : toastEl),
  } as unknown as Document;
  try {
    await withApiMock(async () => ({}), async () => {
      await onResume();
    }, { refreshDetail: async () => { throw new Error("transient"); } });
    expect(inputEl.value).toBe("");
  } finally {
    globalThis.document = saved.document;
  }
});

test("onResume keeps the textarea cleared when fetchSessions throws after a successful resume POST", async () => {
  state.selected = "session-r";

  const inputEl = { value: "carry on" };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };

  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : toastEl),
  } as unknown as Document;
  try {
    await withApiMock(async () => ({}), async () => {
      await onResume();
    }, { fetchSessions: async () => { throw new Error("transient"); } });
    expect(inputEl.value).toBe("");
  } finally {
    globalThis.document = saved.document;
  }
});

// Submitting feedback writes a feedback_received event that the session's
// WebSocket replays as a refreshDetail-driven re-render. A clear that ran
// after the submit await could be stranded by that re-render, leaving the
// already-sent text in the composer — the same race fixed for the resume
// prompt. The clear must happen before the await.
test("onFeedback clears the textarea before the submit await, so a mid-flight re-render can't strand the text", async () => {
  clearAttachments();
  state.selected = "session-fb";
  state.anchor = null;
  state.pendingAttachments = [];

  const inputEl = { value: "look at this line" };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  let valueWhenSubmitSeen: string | null = null;

  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : toastEl),
  } as unknown as Document;
  try {
    await withApiMock(async () => ({}), async () => {
      await onFeedback();
    }, {
      submitFeedback: async () => { valueWhenSubmitSeen = inputEl.value; return { filename: "001-x.md", seq: 1 }; },
    });
    expect(valueWhenSubmitSeen).toBe("");
    expect(inputEl.value).toBe("");
  } finally {
    globalThis.document = saved.document;
  }
});

test("onFeedback restores the text when submitFeedback fails, so the message isn't lost", async () => {
  clearAttachments();
  state.selected = "session-fb";
  state.anchor = null;
  state.pendingAttachments = [];

  const inputEl = { value: "important feedback" };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };

  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : toastEl),
  } as unknown as Document;
  try {
    await withApiMock(async () => ({}), async () => {
      await onFeedback();
    }, { submitFeedback: async () => { throw new Error("boom"); } });
    expect(inputEl.value).toBe("important feedback");
  } finally {
    globalThis.document = saved.document;
  }
});

// refreshDetail occasionally loses the race against the events the submit just
// produced. That failure must not drag the text back — the feedback was sent.
test("onFeedback keeps the textarea cleared when refreshDetail throws after a successful submit", async () => {
  clearAttachments();
  state.selected = "session-fb";
  state.anchor = null;
  state.pendingAttachments = [];

  const inputEl = { value: "look at this line" };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };

  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : toastEl),
  } as unknown as Document;
  try {
    await withApiMock(async () => ({}), async () => {
      await onFeedback();
    }, { refreshDetail: async () => { throw new Error("transient"); } });
    expect(inputEl.value).toBe("");
  } finally {
    globalThis.document = saved.document;
  }
});

test("onStopAndResume keeps the textarea cleared when refreshDetail throws after both POSTs succeed", async () => {
  state.selected = "session-s";

  const inputEl = { value: "go again" };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };

  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : toastEl),
  } as unknown as Document;
  try {
    await withApiMock(async () => ({}), async () => {
      await onStopAndResume();
    }, { refreshDetail: async () => { throw new Error("transient"); } });
    expect(inputEl.value).toBe("");
  } finally {
    globalThis.document = saved.document;
  }
});

test("onQueueFeedback adds an item to feedbackQueue and clears the textarea", () => {
  state.selected = "session-q";
  state.anchor = null;
  state.feedbackQueue = [];

  const inputEl = { value: "first" };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : toastEl),
  } as unknown as Document;
  try {
    onQueueFeedback();
    expect(state.feedbackQueue).toHaveLength(1);
    expect(state.feedbackQueue[0].content).toBe("first");
    expect(inputEl.value).toBe("");
  } finally {
    globalThis.document = saved.document;
  }
});

test("onFeedback flushes the queue via submitFeedbackBatch when items are queued", async () => {
  state.selected = "session-batch";
  state.anchor = null;
  state.feedbackQueue = [
    { content: "queued-1", slug: "feedback" },
    { content: "queued-2", slug: "feedback" },
  ];
  state.pendingAttachments = [];
  submitFeedbackBatchCalls.length = 0;
  submitFeedbackCalls.length = 0;

  const inputEl = { value: "final" };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  const saved = { document: globalThis.document };
  globalThis.document = {
    querySelector: (sel: string) => (sel === "#feedbackInput" ? inputEl : toastEl),
  } as unknown as Document;
  try {
    await onFeedback();
    expect(submitFeedbackBatchCalls).toHaveLength(1);
    expect(submitFeedbackBatchCalls[0].items).toHaveLength(3);
    expect(submitFeedbackCalls).toHaveLength(0);
    expect(state.feedbackQueue).toEqual([]);
    expect(inputEl.value).toBe("");
  } finally {
    globalThis.document = saved.document;
  }
});

test("selectSession clears feedbackQueue", async () => {
  state.feedbackQueue = [{ content: "stale", slug: "feedback" }];
  await selectSession("session-new");
  expect(state.feedbackQueue).toEqual([]);
});

test("removeQueuedFeedback removes the item at the given index", () => {
  state.feedbackQueue = [
    { content: "a", slug: "feedback" },
    { content: "b", slug: "feedback" },
    { content: "c", slug: "feedback" },
  ];
  removeQueuedFeedback(1);
  expect(state.feedbackQueue).toHaveLength(2);
  expect(state.feedbackQueue[0].content).toBe("a");
  expect(state.feedbackQueue[1].content).toBe("c");
});

test("onFeedbackDelete confirms, calls DELETE, cleans toggle, and refreshes detail", async () => {
  state.selected = "session-fd";
  state.feedbackToggle = new Map([["003-anchored.md", true]]);
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let refreshed = false;

  const savedConfirm = globalThis.confirm;
  (globalThis as unknown as { confirm: unknown }).confirm = () => true;

  try {
    await withApiMock(async (method, path, body) => {
      calls.push({ method, path, body });
      return { ok: true, filename: "003-anchored.md" };
    }, async () => {
      await onFeedbackDelete("003-anchored.md");
    }, { refreshDetail: async () => { refreshed = true; } });
  } finally {
    (globalThis as unknown as { confirm: unknown }).confirm = savedConfirm;
  }

  expect(calls).toEqual([{ method: "DELETE", path: "/sessions/session-fd/feedback/003-anchored.md", body: undefined }]);
  expect(state.feedbackToggle.has("003-anchored.md")).toBe(false);
  expect(refreshed).toBe(true);
});

test("onFeedbackDelete bails when the human cancels the confirm dialog", async () => {
  state.selected = "session-fd";
  const calls: Array<{ method: string; path: string }> = [];

  const savedConfirm = globalThis.confirm;
  (globalThis as unknown as { confirm: unknown }).confirm = () => false;

  try {
    await withApiMock(async (method, path) => {
      calls.push({ method, path });
      return {};
    }, async () => {
      await onFeedbackDelete("003-anchored.md");
    });
  } finally {
    (globalThis as unknown as { confirm: unknown }).confirm = savedConfirm;
  }

  expect(calls).toEqual([]);
});


// --- asking (escalation) attachments -----------------------------------------

test("addAskingAttachmentFiles stages chips keyed by escalation filename", () => {
  state.askingAttachments = new Map();
  addAskingAttachmentFiles("001-q.md", [
    fakeFile("a.png", "image/png", 100),
    fakeFile("b.jpg", "image/jpeg", 200),
  ]);
  const list = state.askingAttachments.get("001-q.md")!;
  expect(list).toHaveLength(2);
  expect(list[0].file.name).toBe("a.png");
  expect(list[1].file.name).toBe("b.jpg");
});

test("addAskingAttachmentFiles keeps separate queues per filename", () => {
  state.askingAttachments = new Map();
  addAskingAttachmentFiles("001-q.md", [fakeFile("a.png", "image/png", 100)]);
  addAskingAttachmentFiles("002-q.md", [fakeFile("b.png", "image/png", 100)]);
  expect(state.askingAttachments.get("001-q.md")!.map(a => a.file.name)).toEqual(["a.png"]);
  expect(state.askingAttachments.get("002-q.md")!.map(a => a.file.name)).toEqual(["b.png"]);
});

test("addAskingAttachmentFiles rejects non-image types", async () => {
  state.askingAttachments = new Map();
  await withFakeDocument(() => {
    addAskingAttachmentFiles("001-q.md", [
      fakeFile("bad.pdf", "application/pdf", 100),
      fakeFile("good.png", "image/png", 100),
    ]);
  });
  expect((state.askingAttachments.get("001-q.md") ?? []).map(a => a.file.name)).toEqual(["good.png"]);
});

test("removeAskingAttachment splices a specific chip from the named escalation", () => {
  state.askingAttachments = new Map();
  revokedObjectURLs.length = 0;
  addAskingAttachmentFiles("001-q.md", [
    fakeFile("a.png", "image/png", 1),
    fakeFile("b.png", "image/png", 1),
  ]);
  const list = state.askingAttachments.get("001-q.md")!;
  const idA = list[0].id;
  const urlA = list[0].previewUrl;

  removeAskingAttachment("001-q.md", idA);

  expect((state.askingAttachments.get("001-q.md") ?? []).map(a => a.file.name)).toEqual(["b.png"]);
  expect(revokedObjectURLs).toContain(urlA);
});

test("clearAskingAttachments removes all chips for the named escalation", () => {
  state.askingAttachments = new Map();
  revokedObjectURLs.length = 0;
  addAskingAttachmentFiles("001-q.md", [
    fakeFile("a.png", "image/png", 1),
    fakeFile("b.png", "image/png", 1),
  ]);
  addAskingAttachmentFiles("002-q.md", [fakeFile("c.png", "image/png", 1)]);

  clearAskingAttachments("001-q.md");

  expect(state.askingAttachments.has("001-q.md")).toBe(false);
  expect(state.askingAttachments.get("002-q.md")!.map(a => a.file.name)).toEqual(["c.png"]);
});

test("onResolve sends text and asking attachments via resolveEscalation then clears chips", async () => {
  state.selected = "sess-esc";
  state.askingAttachments = new Map();
  resolveEscalationCalls.length = 0;
  addAskingAttachmentFiles("001-q.md", [fakeFile("pic.png", "image/png", 50)]);

  const textarea = { value: "here is context" };
  const article = {
    querySelector: (sel: string) => (sel === ".ask-answer" ? textarea : sel === ".ask-resolve" ? {} : null),
    querySelectorAll: () => [],
  };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  const saved = globalThis.document;
  globalThis.document = { querySelector: () => toastEl } as unknown as Document;
  try {
    await onResolve("001-q.md", article, null);
    expect(resolveEscalationCalls).toHaveLength(1);
    expect(resolveEscalationCalls[0].sessionId).toBe("sess-esc");
    expect(resolveEscalationCalls[0].filename).toBe("001-q.md");
    expect(resolveEscalationCalls[0].payload).toEqual({ content: "here is context" });
    expect((resolveEscalationCalls[0].attachments as unknown[]).length).toBe(1);
    expect(state.askingAttachments.has("001-q.md")).toBe(false);
  } finally {
    globalThis.document = saved;
  }
});

test("onResolve allows image-only answers (no text) with a placeholder body", async () => {
  state.selected = "sess-esc2";
  state.askingAttachments = new Map();
  resolveEscalationCalls.length = 0;
  addAskingAttachmentFiles("002-q.md", [fakeFile("pic.png", "image/png", 50)]);

  const textarea = { value: "  " };
  const article = {
    querySelector: (sel: string) => (sel === ".ask-answer" ? textarea : null),
    querySelectorAll: () => [],
  };
  const toastEl = { textContent: "", classList: { add() {}, remove() {} } };
  const saved = globalThis.document;
  globalThis.document = { querySelector: () => toastEl } as unknown as Document;
  try {
    await onResolve("002-q.md", article, null);
    expect(resolveEscalationCalls).toHaveLength(1);
    expect(resolveEscalationCalls[0].payload).toEqual({ content: "(image attached)" });
  } finally {
    globalThis.document = saved;
  }
});
