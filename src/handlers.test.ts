import { test, expect, mock } from "bun:test";

// selectSession reaches into the network (api); stub it so the per-session
// state reset can be asserted in isolation.
const reorderSessionsCalls: string[][] = [];
let fetchSessionsCalls = 0;
let fetchArchivedSessionsCalls = 0;
const apiCalls: Array<{ method: string; path: string; body?: unknown }> = [];
mock.module("../web/api.js", () => ({
  api: async (method: string, path: string, body?: unknown) => { apiCalls.push({ method, path, body }); return {}; },
  fetchSessions: async () => { fetchSessionsCalls++; },
  fetchArchivedSessions: async () => { fetchArchivedSessionsCalls++; },
  fetchActions: async () => {},
  reorderSessions: async (ids: string[]) => { reorderSessionsCalls.push(ids); },
  refreshDetail: async () => {},
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
const { selectSession, switchTab, extractPullRequestUrl, onDetailBodyClick, runOpenAction, onReorderSessions, onReportMark, revealReport, closeCodeNav, gotoAnchorTarget, gotoArticle, hideFeedbackPin, onDetailBodyPointerOver, onDetailBodyPointerOut, pushStructureFocus, popStructureFocus, clearStructureFocus, applyUrlState, onSidebarTab, onArchive, onDeleteArchived, onToggleArchivedSelection, onSelectAllArchived, onClearArchivedSelection, onBulkDeleteArchived, onUnarchive, toggleSidebar } = await import("../web/handlers.js");
const { state, isReportExpanded, isFeedbackExpanded } = await import("../web/state.svelte.js");

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
