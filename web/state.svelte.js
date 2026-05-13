// Single source of truth for the worqload frontend's in-browser view state,
// plus the small pure queries that derive display flags from it. `$state`
// makes mutations reactive for the Svelte components; the data layer (api.js)
// and the action handlers (handlers.js) mutate it, the components re-render.
// (`bun test` loads this module without the Svelte compiler — see
// src/svelte-runes-test-shim.ts.)

export const state = $state({
  sessions: [],
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
  files: [],             // worktree-relative paths for the Files tab
  filesLoaded: false,
  fileTreeCollapsed: new Set(),  // directory paths collapsed in the Files tab
  selectedFilePath: null,        // path of the file open in the content pane
  fileContent: null,     // { path, content } | { path, binary } | { path, tooLarge, size } | { path, error } | { path, loading: true }
  codeNav: null,         // Files-tab code navigation popover: { symbol, path, rect:{top,bottom,left}, definitions:[{path,line,column?,text?}]|null, definitionsStatus:"loading"|"done", references:[{path,line,column?,text?}]|null, referencesStatus:"loading"|"done" } | null
  structure: null,       // Structure tab: { graph:{nodes:[path],edges:[{from,to,symbols}]}, cycles:[[path,...]], changedFiles:[path] } | { loading:true } | { error:string } | null
  structureLoaded: false,
  structureShowSymbols: true,  // Structure tab: whether per-edge import symbol-name labels are drawn (a view preference, not per-session)
  structureAutoZoom: true,     // Structure tab: when on, hovering/focusing a node zooms+pans the canvas to fit the highlighted neighbourhood and restores the previous view on un-hover
  reportToggle: new Map(),    // filename -> true(expanded) | false(collapsed): explicit user override
  feedbackToggle: new Map(),  // feedback filename -> true(expanded) | false(collapsed): explicit user override
  eventToggle: new Map(),     // event seq -> true(expanded): events are collapsed to one line until clicked
  actions: [],           // [{ id, label, description?, confirmMessage?, params? }]
  openActionId: null,    // id of the action whose inline panel is open (null = closed)
  actionRunInFlight: false,  // true while the open action's run request is outstanding (disables the Run button)
  actionResults: new Map(),  // actionId -> last run result observed in this browser view
  renamingSessionId: null,   // session id whose sidebar title is being edited inline (null = none)
  pendingScrollTo: null,     // { anchor: {path,lineStart,lineEnd} } | { article: {attr,value} } | null: a "go to" request DetailBody resolves (scroll + flash) after the next render
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
// first). Drives the per-line feedback chips on the diff/file/report views.
export function feedbacksAnchoredAt(path, lineNo) {
  return state.feedbackHistory
    .filter(f => f.anchor && f.anchor.path === path && lineNo >= f.anchor.lineStart && lineNo <= f.anchor.lineEnd)
    .map(f => f.filename);
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
