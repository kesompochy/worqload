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
  sidebarHidden: false,  // Whether the left sidebar (.sidebar) is collapsed out of the layout. Persisted in localStorage under "worqload:sidebar-hidden"; toggled via the in-sidebar « button and the fixed-position » button surfaced when hidden.
  eventsTabHidden: true, // Whether the Events tab is hidden from the tab bar. Persisted in localStorage under "worqload:events-tab-hidden".
  selected: null,        // session id
  detail: null,          // { meta, events }
  prLink: null,          // selected session's branch→PR-URL lookup: { url } | { url: null, reason } | null. Mirrors prLinks[selected]; the header reads this.
  prLinks: {},           // id → branch→PR-URL result, prefetched in the background off the session-list poll so an opened session shows its link with no delay. Reassigned wholesale ($state doesn't proxy plain-object key adds reactively across modules otherwise — match the actionResults Map convention).
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
  fileEditing: false,    // Files tab: whether the open text file is in the inline editor (textarea) instead of the read-only line view
  fileEditDraft: "",     // Files tab: the editor textarea's bound content while fileEditing; PUT to the server on save
  fileCreating: false,   // Files tab: whether the tree pane's new-file input row is shown
  fileNewPath: "",       // Files tab: the new-file input's bound path while fileCreating; POSTed to create the file
  fileRenaming: false,   // Files tab: whether the open file's header path is shown as a rename input
  fileRenamePath: "",    // Files tab: the rename input's bound path while fileRenaming; POSTed to rename the file
  codeNav: null,         // Files-tab code navigation popover: { symbol, path, rect:{top,bottom,left}, definitions:[{path,line,column?,text?}]|null, definitionsStatus:"loading"|"done", references:[{path,line,column?,text?}]|null, referencesStatus:"loading"|"done" } | null
  structure: null,       // Structure tab (file mode): { graph:{nodes:[path],edges:[{from,to,symbols}]}, cycles:[[path,...]], changedFiles:[path] } | { loading:true } | { error:string } | null
  structureLoaded: false,
  // Structure tab "Before" snapshot (file mode): same payload shape as
  // `structure`, but computed against the diff base's tree. Loaded only when
  // `structureSplit` is on, so the canvas can render Before and After side by
  // side. Stays null until the first split fetch resolves.
  structureBefore: null,
  structureBeforeLoaded: false,
  structureSplit: false,       // Structure tab: split (Before | After) view toggle. Toggles visibility of the Before canvas only; the Before payload is fetched eagerly on tab open in both file and function modes so flipping the toggle is instantaneous.
  callGraph: null,       // Structure tab (function mode): { graph, cycles, changedFunctions, nodeMeta } | { loading } | { error } | null — built from LSP callHierarchy
  callGraphLoaded: false,
  // Structure tab "Before" call graph (function mode): same shape as
  // `callGraph` but computed against the diff base via a second LSP. Loaded
  // alongside the After call graph whenever the Structure tab is active —
  // split is purely a visibility toggle, not a fetch gate.
  callGraphBefore: null,
  callGraphBeforeLoaded: false,
  structureMode: "file", // Structure tab: "file" (import graph) | "function" (call graph via LSP)
  structureShowSymbols: true,  // Structure tab: whether per-edge import symbol-name labels are drawn (a view preference, not per-session)
  structureFocusStack: [],     // Structure tab focus history: each entry is a graph node id. Empty = whole graph. Top of stack is the current focus and the graph is filtered to that node and its direct neighbours. Clicking a node pushes; Back pops; Clear empties.
  structureAnchor: null,       // Structure tab: { kind:"file", path } | { kind:"symbol", path, line } | null. null = default scope (the diff's changeset); a file anchor re-seeds the graph from that file's neighbourhood; a symbol anchor (function mode) re-seeds the call graph from that specific function (1-based line for human-readability — converted to 0-based at the api boundary). Pushed in from the Files/Diff tabs' "Show in Structure" buttons (file kind) and the code-nav popover (symbol kind).
  structureHops: null,         // Structure tab: neighbourhood radius override (integer 0–4) | null = server default (2). The toolbar exposes a small selector once the user wants something other than the default.
  reportToggle: new Map(),    // filename -> true(expanded) | false(collapsed): explicit user override
  reportViewRaw: new Map(),   // filename -> true: show raw markdown source instead of rendered HTML
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
  // Image attachments the human pasted/dropped into either composer (the bottom
  // one and the floating anchored one share this list — only one composer
  // submits, and that submit takes whatever is queued). Each entry is
  // { id, file, previewUrl }; previewUrl is a blob: URL the chip <img> renders
  // and is revoked when the entry is removed or cleared.
  pendingAttachments: [],
  // Image attachments staged per escalation answer textarea. Keyed by
  // escalation filename so each asking card has its own attachment queue.
  // Each value is an array of { id, file, previewUrl } — same shape as
  // pendingAttachments entries.
  askingAttachments: new Map(),
  // Batch feedback queue: items staged by Ctrl+Enter, flushed together by Enter.
  // Each entry is { content, slug, anchor? }.
  feedbackQueue: [],
});

// Image-only attachments, capped per-file and per-feedback. The browser does
// the same checks on the server (see web-server.ts); these are the immediate
// feedback the human gets while staging chips.
export const ATTACHMENT_ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 5;

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

export function isReportViewRaw(report) {
  return state.reportViewRaw.get(report.filename) === true;
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
