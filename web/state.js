// Single source of truth for the worqload frontend's in-browser view state,
// plus the small pure queries that derive display flags from it.

export const state = {
  sessions: [],
  selected: null,        // session id
  detail: null,          // { meta, events }
  reports: [],
  asking: [],
  feedbackHistory: [],
  ws: null,
  lastSeq: 0,
  activeTab: "reports",  // "reports" | "diff" | "files" | "events"
  tabScroll: new Map(),  // tab name -> remembered scroll position (see render.js), so switching back returns there
  diff: "",              // text/plain diff (full file context, -U<huge>)
  diffBase: "base-branch",  // "base-branch" (PR-style: branch's own changes vs the base branch) | "session-start" (everything since the worktree was created)
  anchor: null,          // { path, lineStart, lineEnd } | null
  collapsedFiles: new Set(),  // paths of diff files the user collapsed
  diffExpansions: new Map(),  // path -> [[from,to], ...] new-line ranges the user expanded into
  files: [],             // worktree-relative paths for the Files tab
  filesLoaded: false,
  fileTreeCollapsed: new Set(),  // directory paths collapsed in the Files tab
  selectedFilePath: null,        // path of the file open in the content pane
  fileContent: null,     // { path, content } | { path, binary } | { path, tooLarge, size } | { path, error } | { path, loading: true }
  reportToggle: new Map(),    // filename -> true(expanded) | false(collapsed): explicit user override
  feedbackToggle: new Map(),  // feedback filename -> true(expanded) | false(collapsed): explicit user override
  eventToggle: new Map(),     // event seq -> true(expanded): events are collapsed to one line until clicked
  actions: [],           // [{ id, label, description?, confirmMessage?, params? }]
  openActionId: null,    // id of the action whose inline panel is open (null = closed)
  actionResults: new Map(),  // actionId -> last run result observed in this browser view
  renamingSessionId: null,   // session id whose sidebar title is being edited inline (null = none)
};

// Diff view: the server hands us full file context; we collapse unchanged
// stretches by default and let the human expand them GitHub-style.
export const DIFF_CONTEXT_LINES = 3;   // unchanged lines kept around each change
export const DIFF_EXPAND_CHUNK = 20;   // unchanged lines revealed per ↑/↓ click
export const DIFF_MIN_COLLAPSE = 4;    // shorter unchanged runs aren't worth a placeholder

export function isAnchored(path, lineNo) {
  if (!state.anchor || state.anchor.path !== path) return false;
  return lineNo >= state.anchor.lineStart && lineNo <= state.anchor.lineEnd;
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
  // one the human most likely still wants to see; collapse it once consumed.
  return feedback.status === "unread";
}

export function isEventExpanded(event) {
  return state.eventToggle.get(event?.seq) === true;
}
