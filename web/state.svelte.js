// Single source of truth for the worqload frontend's in-browser view state,
// plus the small pure queries that derive display flags from it. `$state`
// makes mutations reactive for the Svelte components; the data layer (api.js)
// and the action handlers (handlers.js) mutate it, the components re-render.
// (`bun test` loads this module without the Svelte compiler — see
// src/svelte-runes-test-shim.ts.)

export const state = $state({
  sessions: [],          // active sessions feed: drives notifications, load average, the active sidebar tab
  archivedSessions: [],  // archived-only feed: drives the archived sidebar tab. Populated when that tab is shown / polled.
  archivedSelection: new Set(),  // ids of archived sessions checked for bulk delete. Cleared on tab switch away from archived. Reassigned wholesale (Svelte 5's $state doesn't proxy Set).
  sidebarTab: "active",  // "active" | "archived": which feed the sidebar renders. Archived cards swap Stop/Archive for a permanent Delete (see SessionList.svelte / handlers.js).
  selected: null,        // session id
  detail: null,          // { meta, events }
  reports: [],
  asking: [],
  feedbackHistory: [],
  ws: null,
  lastSeq: 0,
  activeTab: "reports",  // "reports" | "feedback" | "diff" | "files" | "structure" | "events"
  tabScroll: new Map(),  // tab name -> remembered scroll position (see DetailBody.svelte), so switching back returns there
  diff: "",              // text/plain diff (full file context, -U<huge>) — the branch's changes since the session forked
  anchor: null,          // { path, lineStart, lineEnd } | null
  collapsedFiles: new Set(),  // paths of diff files the user collapsed
  diffExpansions: new Map(),  // path -> [[from,to], ...] new-line ranges the user expanded into
  diffTreeCollapsed: new Set(),  // directory paths collapsed in the Diff tab's left tree
  files: [],             // worktree-relative paths for the Files tab
  filesLoaded: false,
  fileTreeCollapsed: new Set(),  // directory paths collapsed in the Files tab
  selectedFilePath: null,        // path of the file open in the content pane
  fileContent: null,     // { path, content } | { path, binary } | { path, tooLarge, size } | { path, error } | { path, loading: true }
  codeNav: null,         // Files-tab code navigation popover: { symbol, path, rect:{top,bottom,left}, definitions:[{path,line,column?,text?}]|null, definitionsStatus:"loading"|"done", references:[{path,line,column?,text?}]|null, referencesStatus:"loading"|"done" } | null
  structure: null,       // Structure tab (file mode): { graph:{nodes:[path],edges:[{from,to,symbols}]}, cycles:[[path,...]], changedFiles:[path] } | { loading:true } | { error:string } | null
  structureLoaded: false,
  callGraph: null,       // Structure tab (function mode): { graph, cycles, changedFunctions, nodeMeta } | { loading } | { error } | null — built from LSP callHierarchy
  callGraphLoaded: false,
  structureMode: "file", // Structure tab: "file" (import graph) | "function" (call graph via LSP)
  structureShowSymbols: true,  // Structure tab: whether per-edge import symbol-name labels are drawn (a view preference, not per-session)
  structureFocusStack: [],     // Structure tab focus history: each entry is a graph node id. Empty = whole graph. Top of stack is the current focus and the graph is filtered to that node and its direct neighbours. Clicking a node pushes; Back pops; Clear empties.
  structureAnchor: null,       // Structure tab: { kind:"file", path } | { kind:"symbol", path, line } | null. null = default scope (the diff's changeset); a file anchor re-seeds the graph from that file's neighbourhood; a symbol anchor (function mode) re-seeds the call graph from that specific function (1-based line for human-readability — converted to 0-based at the api boundary). Pushed in from the Files/Diff tabs' "Show in Structure" buttons (file kind) and the code-nav popover (symbol kind).
  structureHops: null,         // Structure tab: neighbourhood radius override (integer 0–4) | null = server default (2). The toolbar exposes a small selector once the user wants something other than the default.
  reportToggle: new Map(),    // filename -> true(expanded) | false(collapsed): explicit user override
  feedbackToggle: new Map(),  // feedback filename -> true(expanded) | false(collapsed): explicit user override
  eventToggle: new Map(),     // event seq -> true(expanded): events are collapsed to one line until clicked
  actions: [],           // [{ id, label, description?, confirmMessage?, direct?, params? }]
  openActionId: null,    // id of the action whose inline panel is open (null = closed)
  actionRunInFlight: false,  // true while any action's run request is outstanding (disables the Run / direct-action buttons)
  runningActionId: null,     // id of the action currently running (drives the per-button spinner on direct actions)
  actionResults: new Map(),  // actionId -> last run result observed in this browser view
  renamingSessionId: null,   // session id whose sidebar title is being edited inline (null = none)
  pendingScrollTo: null,     // { anchor: {path,lineStart,lineEnd} } | { article: {attr,value} } | null: a "go to" request DetailBody resolves (scroll + flash) after the next render
  feedbackPinAt: null,       // { key, filenames: [...], x, y } | null: hovering a left-striped anchored line/block surfaces a 💬 pin at the cursor; hovering that pin opens the preview popover (see handlers.js / AnchoredFeedbackOverlay.svelte)
});

// Diff view: the server hands us full file context; we collapse unchanged
// stretches by default and let the human expand them GitHub-style.
export const DIFF_CONTEXT_LINES = 3;   // unchanged lines kept around each change
export const DIFF_EXPAND_CHUNK = 20;   // unchanged lines revealed per ↑/↓ click
export const DIFF_MIN_COLLAPSE = 4;    // shorter unchanged runs aren't worth a placeholder

// "path:lineStart" or "path:lineStart-lineEnd" — the short label used on anchor
// chips (composer, feedback list). Mirrors the `Re:` line minus the prefix.
export function anchorLabel(anchor) {
  if (!anchor) return "";
  const end = anchor.lineEnd ?? anchor.lineStart;
  return `${anchor.path}:${anchor.lineStart}${end > anchor.lineStart ? `-${end}` : ""}`;
}

export function isAnchored(path, lineNo) {
  if (!state.anchor || state.anchor.path !== path) return false;
  return lineNo >= state.anchor.lineStart && lineNo <= state.anchor.lineEnd;
}

// Sent feedback that is anchored to a line range in `path` (a diff/file path, or
// `./.worqload-reports/<filename>`). feedbackHistory is newest-first.
export function feedbackAnchorsForPath(path) {
  return state.feedbackHistory.filter(f => f.anchor && f.anchor.path === path);
}

// Filenames of every sent feedback whose anchor covers `lineNo` in `path` (newest
// first). Drives the per-line feedback pins on the diff/file/report views.
export function feedbacksAnchoredAt(path, lineNo) {
  return state.feedbackHistory
    .filter(f => f.anchor && f.anchor.path === path && lineNo >= f.anchor.lineStart && lineNo <= f.anchor.lineEnd)
    .map(f => f.filename);
}

// For the floating preview popover: given feedback filenames (as carried on a
// `data-feedback-preview` pin), resolve each to its feedback entry plus the
// reports written in reply to it. Unknown filenames are dropped.
export function feedbackPreviewEntries(filenames) {
  return filenames
    .map(name => {
      const feedback = state.feedbackHistory.find(f => f.filename === name);
      if (!feedback) return null;
      return { feedback, replies: state.reports.filter(r => r.replyTo === name) };
    })
    .filter(Boolean);
}

export function isReportExpanded(report) {
  if (state.reportToggle.has(report.filename)) {
    return state.reportToggle.get(report.filename);
  }
  return !report.read;
}

export function isFeedbackExpanded(feedback) {
  if (state.feedbackToggle.has(feedback.filename)) {
    return state.feedbackToggle.get(feedback.filename);
  }
  // "unread" feedback (the agent has not fetched it yet) is the recently sent
  // one the human most likely still wants to see — including command-execution
  // results just after the run; collapse it once consumed so a reload doesn't
  // reopen it.
  return feedback.status === "unread";
}

export function isEventExpanded(event) {
  return state.eventToggle.get(event?.seq) === true;
}
