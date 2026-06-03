// Every user-initiated action: switching sessions, clicking in the detail
// pane, the composer (feedback / resume), session lifecycle (stop / resume /
// archive), gh actions, the new-session modal. Each handler mutates `state`
// and/or calls the data layer; the Svelte components re-render reactively.

import { $, toast } from "./dom.js";
import { state, isReportExpanded, isFeedbackExpanded, feedbackPreviewEntries, DIFF_EXPAND_CHUNK, ATTACHMENT_ALLOWED_MIMES, ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "./state.svelte.js";
import { parseDiffFiles, mergeLineRanges } from "./diff-view.js";
import { languageForPath } from "./syntax-highlight.js";
import { isIdentifierName, resolveDefinitions, resolveReferences } from "./code-nav.js";
import {
  api,
  submitFeedback,
  fetchSessions,
  fetchArchivedSessions,
  fetchActions,
  reorderSessions,
  refreshDetail,
  loadPrLink,
  refreshDiff,
  ensureFilesLoaded,
  ensureStructureViewLoaded,
  selectFile,
  saveFile,
  createFile,
  deleteFile,
  renameFile,
  openWs,
} from "./api.js";
import { pushUrlState, replaceUrlState } from "./url-state.js";

// `historyAction` controls how the resulting URL change interacts with the
// browser back/forward stack:
//   "push"    → user-initiated navigation, default. Adds a history entry so
//               Back lands here.
//   "replace" → canonicalising the URL on initial load. No new history entry.
//   "none"    → the URL is already where it belongs (we got here from a
//               popstate event). Skip the sync entirely.
function syncHistory(action, urlState) {
  if (action === "push") pushUrlState(urlState);
  else if (action === "replace") replaceUrlState(urlState);
}

export async function selectSession(id, { historyAction = "push" } = {}) {
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.selected = id;
  syncHistory(historyAction, { sessionId: id, tab: state.activeTab, focusStack: [] });
  state.renamingSessionId = null;
  state.lastSeq = 0;
  state.reports = [];
  state.asking = [];
  state.detail = null;
  // Seed from the background-prefetched cache so the header renders the PR
  // link / Create-PR-disabled state on the first paint, with no open-time
  // flip. undefined (never prefetched — e.g. first boot) falls back to a
  // fetch below; the prLinks cache survives session switches.
  state.prLink = state.prLinks[id] ?? null;
  // An anchor's path resolves only inside the previous session's worktree, so
  // it must not ride along to feedback sent to the newly selected one.
  state.anchor = null;
  state.collapsedFiles = new Set();
  state.diffExpansions = new Map();
  state.diffTreeCollapsed = new Set();
  state.reportToggle = new Map();
  state.feedbackToggle = new Map();
  state.eventToggle = new Map();
  state.tabScroll = new Map();
  state.files = [];
  state.filesLoaded = false;
  state.fileTreeCollapsed = new Set();
  state.selectedFilePath = null;
  state.fileContent = null;
  state.fileEditing = false;
  state.fileEditDraft = "";
  state.fileCreating = false;
  state.fileNewPath = "";
  state.fileRenaming = false;
  state.fileRenamePath = "";
  state.codeNav = null;
  state.actions = [];
  state.structure = null;
  state.structureLoaded = false;
  state.structureBefore = null;
  state.structureBeforeLoaded = false;
  state.callGraph = null;
  state.callGraphLoaded = false;
  state.callGraphBefore = null;
  state.callGraphBeforeLoaded = false;
  state.structureFocusStack = [];
  state.structureAnchor = null;
  state.structureHops = null;
  state.structureSplit = false;
  state.openActionId = null;
  state.actionRunInFlight = false;
  state.runningActionId = null;
  state.actionResults = new Map();
  state.pendingScrollTo = null;
  state.feedbackPinAt = null;
  // Image attachments staged in either composer belong to the previous session
  // (the multipart POST targets that session's id). Drop them and revoke the
  // blob URLs so the chips don't leak across sessions or memory.
  clearAttachments();
  if (!id) return;
  await refreshDetail();
  // Cold cache only (first boot, before the prefetch resolved). The warm case
  // already rendered from state.prLinks above with no round trip; refreshing
  // it here too would reintroduce the open-time flip the prefetch removes.
  if (state.prLinks[id] === undefined) void loadPrLink(id);
  await fetchActions(id);
  openWs(id);
}

export function onDetailBodyClick(e) {
  // A link inside report markdown carries target="_blank"; let the browser
  // open it natively. Intercepting the click would fall through to onLineClick,
  // which re-renders the pane and detaches the <a> before navigation, so the
  // new tab never opens.
  if (e.target.closest("a")) return;
  // A feedback anchor chip: jump to the diff/file/report line it points at.
  // Sits before the data-feedback-toggle branch because the chip lives inside
  // the feedback header (which carries that attribute).
  const gotoAnchor = e.target.closest("[data-goto-anchor-path]");
  if (gotoAnchor) {
    gotoAnchorTarget(
      gotoAnchor.getAttribute("data-goto-anchor-path"),
      Number(gotoAnchor.getAttribute("data-goto-anchor-line")),
      Number(gotoAnchor.getAttribute("data-goto-anchor-line-end")),
    );
    return;
  }
  const gotoFeedbackEl = e.target.closest("[data-goto-feedback]");
  if (gotoFeedbackEl) {
    gotoArticle("feedback", gotoFeedbackEl.getAttribute("data-goto-feedback"));
    return;
  }
  const gotoReportEl = e.target.closest("[data-goto-report]");
  if (gotoReportEl) {
    gotoArticle("reports", gotoReportEl.getAttribute("data-goto-report"));
    return;
  }
  // The pending-asking section (DetailBody.svelte) renders its resolve buttons
  // natively; the answer textarea is read here off the enclosing article.
  const askBtn = e.target.closest(".ask-resolve, .ask-approve, .ask-reject");
  if (askBtn) {
    const article = askBtn.closest("[data-asking]");
    if (!article) return;
    const filename = article.getAttribute("data-asking");
    if (askBtn.classList.contains("ask-resolve")) onResolve(filename, article, askBtn);
    else if (askBtn.classList.contains("ask-approve")) onResolveCommand(filename, "approve", article, askBtn);
    else onResolveCommand(filename, "reject", article, askBtn);
    return;
  }
  const markBtn = e.target.closest("[data-report-mark]");
  if (markBtn) {
    e.stopPropagation();
    const filename = markBtn.getAttribute("data-report-mark");
    const to = markBtn.getAttribute("data-report-mark-to");
    onReportMark(filename, to === "read");
    return;
  }
  const deleteBtn = e.target.closest("[data-report-delete]");
  if (deleteBtn) {
    // Sits inside the report header (a toggle target); stop the click from also
    // collapsing the card on its way out.
    e.stopPropagation();
    onReportDelete(deleteBtn.getAttribute("data-report-delete"));
    return;
  }
  const reportToggle = e.target.closest("[data-report-toggle]");
  if (reportToggle) {
    const filename = reportToggle.getAttribute("data-report-toggle");
    const report = state.reports.find(r => r.filename === filename);
    const currentlyExpanded = report ? isReportExpanded(report) : true;
    // Reassign rather than mutate in place: Svelte 5's $state doesn't proxy
    // Maps, so the components only re-render when the property itself is replaced.
    state.reportToggle = new Map(state.reportToggle).set(filename, !currentlyExpanded);
    return;
  }
  const feedbackToggle = e.target.closest("[data-feedback-toggle]");
  if (feedbackToggle) {
    const filename = feedbackToggle.getAttribute("data-feedback-toggle");
    const feedback = state.feedbackHistory.find(f => f.filename === filename);
    const currentlyExpanded = feedback ? isFeedbackExpanded(feedback) : true;
    state.feedbackToggle = new Map(state.feedbackToggle).set(filename, !currentlyExpanded);
    return;
  }
  const eventToggle = e.target.closest("[data-event-toggle]");
  if (eventToggle) {
    const seq = Number(eventToggle.getAttribute("data-event-toggle"));
    state.eventToggle = new Map(state.eventToggle).set(seq, state.eventToggle.get(seq) !== true);
    return;
  }
  // The copy button lives inside the click-to-collapse diff-file header, so this
  // branch has to run before the data-diff-toggle one or the same click folds
  // the file too.
  const copyPathBtn = e.target.closest("[data-copy-path]");
  if (copyPathBtn) {
    e.stopPropagation();
    const path = copyPathBtn.getAttribute("data-copy-path");
    navigator.clipboard.writeText(path).then(() => toast("path copied")).catch(() => toast("copy failed"));
    return;
  }
  // The markdown-rendered fenced-code wrapper's copy button (renderMarkdown wraps
  // `<pre><code>` in `.md-code-block`). The raw code is read from the inner
  // `<code>` element's textContent — escapeHtml affects the source string, not
  // what the DOM hands back via textContent.
  const copyCodeBtn = e.target.closest("[data-copy-code]");
  if (copyCodeBtn) {
    e.stopPropagation();
    const codeEl = copyCodeBtn.closest(".md-code-block")?.querySelector("pre code");
    const text = codeEl ? codeEl.textContent : "";
    navigator.clipboard.writeText(text).then(() => toast("code copied")).catch(() => toast("copy failed"));
    return;
  }
  // Lives inside the click-to-collapse diff-file header too — same as copy-path,
  // stop before the data-diff-toggle branch folds the file.
  const permalinkBtn = e.target.closest("[data-permalink-path]");
  if (permalinkBtn) {
    e.stopPropagation();
    copyPermalink(permalinkBtn.getAttribute("data-permalink-path"));
    return;
  }
  // "Show in Structure" buttons live on the Files-tab file header and on each
  // Diff-tab file header; they switch tabs and re-seed the Structure graph at
  // the given file. stopPropagation is needed inside diff-file headers (same
  // reason as copy-path).
  const anchorBtn = e.target.closest("[data-structure-anchor]");
  if (anchorBtn) {
    e.stopPropagation();
    void setStructureAnchor(anchorBtn.getAttribute("data-structure-anchor"));
    return;
  }
  // Files-tab editor controls: ✎ opens the inline editor seeded with the open
  // file's text; save/cancel commit or drop the draft.
  if (e.target.closest("[data-file-edit]")) {
    const fc = state.fileContent;
    if (fc && typeof fc.content === "string") {
      state.fileEditDraft = fc.content;
      state.fileEditing = true;
    }
    return;
  }
  if (e.target.closest("[data-file-edit-save]")) {
    void saveFile();
    return;
  }
  if (e.target.closest("[data-file-edit-cancel]")) {
    state.fileEditing = false;
    return;
  }
  // Files-tab new-file controls: ＋ opens the tree-pane path input, then
  // 作成/キャンセル commit or drop it.
  if (e.target.closest("[data-file-new]")) {
    state.fileNewPath = "";
    state.fileCreating = true;
    return;
  }
  if (e.target.closest("[data-file-new-confirm]")) {
    void createFile(state.fileNewPath);
    return;
  }
  if (e.target.closest("[data-file-new-cancel]")) {
    state.fileCreating = false;
    return;
  }
  if (e.target.closest("[data-file-delete]")) {
    void onDeleteFile();
    return;
  }
  // Files-tab rename controls: 🏷 turns the header path into an input seeded
  // with the open file's path; 確定/キャンセル commit or drop it.
  if (e.target.closest("[data-file-rename]")) {
    state.fileRenamePath = state.selectedFilePath ?? "";
    state.fileRenaming = true;
    return;
  }
  if (e.target.closest("[data-file-rename-confirm]")) {
    void renameFile(state.fileRenamePath);
    return;
  }
  if (e.target.closest("[data-file-rename-cancel]")) {
    state.fileRenaming = false;
    return;
  }
  const toggle = e.target.closest("[data-diff-toggle]");
  if (toggle) {
    const path = toggle.getAttribute("data-diff-toggle");
    // Reassign rather than mutate in place: Svelte 5's $state doesn't proxy
    // Sets, so DiffView only re-derives when the property itself is replaced.
    const next = new Set(state.collapsedFiles);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    state.collapsedFiles = next;
    return;
  }
  const expandBtn = e.target.closest("[data-expand-dir]");
  if (expandBtn) {
    expandDiffGap(
      expandBtn.getAttribute("data-expand-path"),
      Number(expandBtn.getAttribute("data-expand-from")),
      Number(expandBtn.getAttribute("data-expand-to")),
      expandBtn.getAttribute("data-expand-dir"),
    );
    return;
  }
  const diffDirToggle = e.target.closest("[data-diff-dir-toggle]");
  if (diffDirToggle) {
    const path = diffDirToggle.getAttribute("data-diff-dir-toggle");
    const next = new Set(state.diffTreeCollapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    state.diffTreeCollapsed = next;
    return;
  }
  const diffFileJump = e.target.closest("[data-diff-file-jump]");
  if (diffFileJump) {
    const path = diffFileJump.getAttribute("data-diff-file-jump");
    if (state.collapsedFiles.has(path)) {
      const next = new Set(state.collapsedFiles);
      next.delete(path);
      state.collapsedFiles = next;
    }
    // The user explicitly picked this file, so they don't need the smooth scroll
    // to orient themselves to the new position — jump straight there.
    state.pendingScrollTo = { article: { attr: "data-diff-path", value: path }, instant: true };
    return;
  }
  const dirToggle = e.target.closest("[data-dir-toggle]");
  if (dirToggle) {
    const path = dirToggle.getAttribute("data-dir-toggle");
    // Reassigned wholesale, not mutated: $state doesn't proxy Set, so the
    // Files explorer only re-renders when the property itself changes.
    const next = new Set(state.fileTreeCollapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    state.fileTreeCollapsed = next;
    return;
  }
  const fileOpen = e.target.closest("[data-file-open]");
  if (fileOpen) {
    selectFile(fileOpen.getAttribute("data-file-open"));
    return;
  }
  const structureOpen = e.target.closest("[data-structure-open]");
  if (structureOpen) {
    // `data-structure-id` is the graph node's identifier (== file path in file
    // mode, function id in function mode). `data-structure-open` is the file
    // path to open; `data-structure-line` (function mode) is its 1-based line.
    const id = structureOpen.getAttribute("data-structure-id") ?? structureOpen.getAttribute("data-structure-open");
    if (e.shiftKey) {
      const path = structureOpen.getAttribute("data-structure-open");
      const lineAttr = structureOpen.getAttribute("data-structure-line");
      const line = lineAttr ? Number(lineAttr) : NaN;
      if (Number.isFinite(line) && line >= 1) revealFileLocation(path, line);
      else openFileFromStructure(path);
      return;
    }
    pushStructureFocus(id);
    return;
  }
  // A symbol token in the Files-tab content pane or the Diff-tab body
  // (highlighter wraps plain identifiers in .tok-ident in both) — open the
  // code-navigation popover instead of anchoring the line. Anchoring still
  // works by clicking the line number.
  const identToken = e.target.closest(".tok-ident");
  if (identToken && e.target.closest(".file-content-body, .diff-file-body")) {
    openCodeNav(identToken);
    return;
  }
  onLineClick(e);
}

// Delete the file open in the Files-tab content pane. Confirms first (the file
// leaves the worktree), then hands off to the data layer, which refreshes the
// tree and clears the content pane.
export async function onDeleteFile() {
  const path = state.selectedFilePath;
  if (!path) return;
  const message = `${path} を削除します。よろしいですか？`;
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(message)) return;
  await deleteFile(path);
}

// Code navigation (Files tab): clicking a symbol token opens a popover with the
// symbol's definition(s) and uses, resolved through the providers in code-nav.js
// (the language server when one is available, the per-line heuristic otherwise).
// Definitions and references resolve independently and asynchronously; a counter
// discards an answer that lands after the popover was closed or moved to another
// symbol.
let codeNavRequestSeq = 0;

// The 0-based character offset of `tokenEl` within its line's rendered text.
// The highlighter emits a flat run of text nodes and one-level spans into
// `.body`, so summing the textContent length of the siblings before the token
// gives its column.
function columnOf(tokenEl, bodyEl) {
  let column = 0;
  for (const node of bodyEl.childNodes) {
    if (node === tokenEl || (node.contains && node.contains(tokenEl))) return column;
    column += (node.textContent ?? "").length;
  }
  return column;
}

export function openCodeNav(tokenEl) {
  const symbol = tokenEl.textContent ?? "";
  if (!isIdentifierName(symbol)) return;
  const lineEl = tokenEl.closest("[data-anchor-line]");
  if (!lineEl) return;
  const path = lineEl.getAttribute("data-anchor-path") || state.selectedFilePath;
  const line = Number(lineEl.getAttribute("data-anchor-line"));
  if (!path || !Number.isFinite(line)) return;
  const bodyEl = tokenEl.closest(".body");
  // The Files-tab cache only counts as source text for the symbol being
  // resolved when it actually holds *that* file: a click in the Diff body for
  // file X must not feed the heuristic file Y's content (whatever the user
  // happened to be viewing in the Files tab).
  const fc = state.fileContent;
  const sourceText = fc && fc.path === path && !fc.loading && !fc.error && !fc.binary && !fc.tooLarge ? (fc.content ?? "") : "";
  const ctx = {
    sessionId: state.selected,
    path,
    language: languageForPath(path),
    sourceText,
    line,
    column: bodyEl ? columnOf(tokenEl, bodyEl) : 0,
    symbol,
  };
  const rect = tokenEl.getBoundingClientRect();
  const seq = ++codeNavRequestSeq;
  state.codeNav = {
    symbol,
    path,
    rect: { top: rect.top, bottom: rect.bottom, left: rect.left },
    definitions: null,
    definitionsStatus: "loading",
    references: null,
    referencesStatus: "loading",
  };
  const apply = patch => {
    if (seq !== codeNavRequestSeq || !state.codeNav) return;
    state.codeNav = { ...state.codeNav, ...patch };
  };
  resolveDefinitions(ctx).then(locations => apply({ definitions: locations ?? [], definitionsStatus: "done" }));
  resolveReferences(ctx).then(locations => apply({ references: locations ?? [], referencesStatus: "done" }));
}

export function closeCodeNav() {
  state.codeNav = null;
}

// --- anchored-feedback hover (pin + preview popover) -----------------------
// A line/block with sent feedback anchored on it carries `[data-feedback-preview]`
// (a left stripe in CSS, the comma-joined feedback filenames as the value).
// Hovering it surfaces a 💬 pin at the cursor; hovering the pin opens a floating
// popover with the feedback bodies and the reports written in reply. The pin and
// popover live on document.body (AnchoredFeedbackOverlay.svelte). Hiding is
// debounced so the cursor can travel line → pin → popover without flicker.
const HOVER_TARGET_SELECTOR = "[data-feedback-preview], .feedback-anchor-pin, .feedback-preview-popover";
let feedbackPinHideTimer = null;

export function cancelFeedbackPinHide() {
  if (feedbackPinHideTimer) { clearTimeout(feedbackPinHideTimer); feedbackPinHideTimer = null; }
}

export function scheduleFeedbackPinHide() {
  cancelFeedbackPinHide();
  feedbackPinHideTimer = setTimeout(() => { state.feedbackPinAt = null; feedbackPinHideTimer = null; }, 200);
}

export function hideFeedbackPin() {
  cancelFeedbackPinHide();
  state.feedbackPinAt = null;
}

// Hover delegation for the detail body. Entering a striped line/block places the
// pin at the pointer (only on the first entry — re-emitted mouseover events from
// child elements keep it put, "the position at first hover"). Leaving one toward
// anything that is neither the line, the pin, nor the popover starts the hide.
export function onDetailBodyPointerOver(e) {
  const lineEl = e.target.closest?.("[data-feedback-preview]");
  if (!lineEl) return;
  cancelFeedbackPinHide();
  const key = lineEl.getAttribute("data-feedback-preview") || "";
  if (state.feedbackPinAt && state.feedbackPinAt.key === key) return;
  const filenames = key.split(",").filter(Boolean);
  if (feedbackPreviewEntries(filenames).length === 0) return;
  state.feedbackPinAt = { key, filenames, x: e.clientX, y: e.clientY };
}

export function onDetailBodyPointerOut(e) {
  const lineEl = e.target.closest?.("[data-feedback-preview]");
  if (!lineEl) return;
  const to = e.relatedTarget;
  if (to && (lineEl.contains(to) || to.closest?.(HOVER_TARGET_SELECTOR))) return;
  scheduleFeedbackPinHide();
}

// Jump the Files tab to a path:line — the action behind a code-nav popover
// entry. Opens the file if it isn't the one shown, anchors the line (so it's
// highlighted and feedback sent now refers to it), and hands DetailBody the
// request to scroll there and flash it (the same mechanism the anchor chips use).
export async function revealFileLocation(path, line) {
  if (!path || !Number.isFinite(line)) return;
  state.codeNav = null;
  if (state.activeTab !== "files") await switchTab("files");
  if (path !== state.selectedFilePath) await selectFile(path);
  state.anchor = { path, lineStart: line, lineEnd: line };
  state.pendingScrollTo = { anchor: { path, lineStart: line, lineEnd: line } };
}

export async function onReportMark(filename, read) {
  if (!state.selected) return;
  const verb = read ? "read" : "unread";
  try {
    await api("POST", `/sessions/${state.selected}/reports/${encodeURIComponent(filename)}/${verb}`, {});
    // Drop any explicit toggle so the new default (collapsed when read,
    // expanded when unread) takes effect on the next render.
    const nextToggle = new Map(state.reportToggle);
    nextToggle.delete(filename);
    state.reportToggle = nextToggle;
    await refreshDetail();
    // The sidebar's unread badge is derived from GET /sessions, not from the
    // detail pane — refresh it too so it tracks the mark without waiting for
    // the report_read websocket round-trip (or the 30s poll).
    await fetchSessions();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// Discards a report the agent filed by mistake. Deletion is irreversible, so we
// confirm first; the server drops the file and broadcasts report_deleted, but we
// refresh here too so the row disappears without waiting for the round trip.
export async function onReportDelete(filename) {
  if (!state.selected) return;
  if (!confirm(`レポート「${filename}」を削除します。元に戻せません。よろしいですか？`)) return;
  try {
    await api("DELETE", `/sessions/${state.selected}/reports/${encodeURIComponent(filename)}`);
    const nextToggle = new Map(state.reportToggle);
    nextToggle.delete(filename);
    state.reportToggle = nextToggle;
    await refreshDetail();
    await fetchSessions();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// collapsedFiles / diffExpansions are reassigned wholesale rather than mutated
// in place: Svelte 5's $state doesn't proxy Sets/Maps, so DiffView (and the
// scroll-capture effect in DetailBody) only react when the property is replaced.
export function onExpandAllDiffFiles() {
  state.collapsedFiles = new Set();
  const expansions = new Map();
  for (const file of parseDiffFiles(state.diff)) expansions.set(file.path, [[1, Infinity]]);
  state.diffExpansions = expansions;
}

export function onCollapseAllDiffFiles() {
  const collapsed = new Set();
  for (const el of document.querySelectorAll("[data-diff-path]")) {
    const path = el.getAttribute("data-diff-path");
    if (path) collapsed.add(path);
  }
  state.collapsedFiles = collapsed;
  state.diffExpansions = new Map();
}

export function expandDiffGap(path, from, to, dir) {
  if (!path || !Number.isFinite(from) || !Number.isFinite(to)) return;
  let range;
  if (dir === "up") range = [Math.max(from, to - DIFF_EXPAND_CHUNK + 1), to];
  else if (dir === "down") range = [from, Math.min(to, from + DIFF_EXPAND_CHUNK - 1)];
  else range = [from, to];
  const existing = state.diffExpansions.get(path) || [];
  const next = new Map(state.diffExpansions);
  next.set(path, mergeLineRanges([...existing, range]));
  state.diffExpansions = next;
}

export function onLineClick(e) {
  // A drag to select text ends with a click event too. Treating it as a line
  // anchor would re-render the pane and discard the selection before the user
  // can copy it, so bail when text is selected — except on Shift+click, which
  // is the deliberate gesture for extending the anchor range.
  const selection = window.getSelection();
  if (!e.shiftKey && selection && !selection.isCollapsed) return;
  const target = e.target.closest("[data-anchor-line]");
  if (!target) return;
  const path = target.getAttribute("data-anchor-path");
  const lineStart = Number(target.getAttribute("data-anchor-line"));
  const lineEndAttr = target.getAttribute("data-anchor-line-end");
  const lineEnd = lineEndAttr !== null ? Number(lineEndAttr) : lineStart;
  if (!path || !Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) return;
  if (e.shiftKey && state.anchor && state.anchor.path === path) {
    state.anchor = {
      path,
      lineStart: Math.min(state.anchor.lineStart, lineStart),
      lineEnd: Math.max(state.anchor.lineEnd, lineEnd),
    };
  } else {
    state.anchor = { path, lineStart, lineEnd };
  }
}

export function clearAnchor() {
  state.anchor = null;
}

// Window-level mousedown handler the floating anchored composer installs while
// an anchor is live: a click outside the composer dismisses it. The bottom
// fixed composer (`.feedback-form`) shares the same anchor, so clicks there are
// preserved; clicks on an anchorable line are preserved too because the line
// click handler will reset the anchor to the new target.
export function onAnchorOutsideClick(target) {
  if (!state.anchor) return;
  if (!target || typeof target.closest !== "function") return;
  if (target.closest(".anchored-composer")) return;
  if (target.closest(".feedback-form")) return;
  if (target.closest("[data-anchor-line]")) return;
  state.anchor = null;
}

// Copy a GitHub-style permalink to a worktree file (and optional line range) at
// the session's current HEAD. The server resolves the remote and sha; we just
// surface the URL or the reason it couldn't. The link only works once the
// session branch is pushed, hence the caveat in the success toast.
export async function copyPermalink(path, lineStart, lineEnd) {
  if (!state.selected || !path) return;
  const params = new URLSearchParams({ path });
  if (lineStart != null) params.set("lineStart", String(lineStart));
  if (lineEnd != null && lineEnd !== lineStart) params.set("lineEnd", String(lineEnd));
  try {
    const res = await api("GET", `/sessions/${state.selected}/permalink?${params}`);
    if (!res.url) {
      const why = res.reason === "no-remote" ? "no git remote"
        : res.reason === "unsupported-host" ? "remote isn't a GitHub host"
        : "no commit on this branch yet";
      toast(`no permalink: ${why}`);
      return;
    }
    await navigator.clipboard.writeText(res.url);
    toast(res.branch ? `permalink copied — resolves once ${res.branch} is pushed` : "permalink copied");
  } catch (e) {
    toast(`permalink failed: ${e.message}`);
  }
}

export function copyAnchorPermalink() {
  if (!state.anchor) return;
  copyPermalink(state.anchor.path, state.anchor.lineStart, state.anchor.lineEnd);
}

// The Structure tab's file/function-mode toggle. Pushes the URL so Back walks
// between modes, and triggers the corresponding fetch lazily (call-graph
// fetches go out to a language server, so we only do it when the user asks).
export async function setStructureMode(mode) {
  if (mode !== "file" && mode !== "function") return;
  if (state.structureMode === mode) return;
  state.structureMode = mode;
  pushUrlState({
    sessionId: state.selected, tab: state.activeTab, focusStack: state.structureFocusStack,
    structureAnchor: state.structureAnchor, structureHops: state.structureHops,
    structureMode: mode,
  });
  if (state.activeTab === "structure") await ensureStructureViewLoaded();
}

export async function switchTab(tab, { historyAction = "push" } = {}) {
  if (tab === state.activeTab) return;
  state.activeTab = tab;
  syncHistory(historyAction, {
    sessionId: state.selected, tab, focusStack: state.structureFocusStack,
    structureAnchor: state.structureAnchor, structureHops: state.structureHops,
    structureMode: state.structureMode,
  });
  if (tab === "diff") await refreshDiff();
  if (tab === "files") await ensureFilesLoaded();
  if (tab === "structure") await ensureStructureViewLoaded();
}

// Open a file from the Structure graph: switch to the Files tab and load it
// there. (Structure nodes carry `data-structure-open`; this is the delegated
// handler in onDetailBodyClick.)
export async function openFileFromStructure(path) {
  if (!path) return;
  await switchTab("files");
  await selectFile(path);
}

// Push a node onto the Structure-tab focus history. The view filters to that
// node and its direct neighbours; clicking another node from the focused
// subgraph pushes again, so Back walks one step out. Clicking the node already
// at the top is a no-op (pushing the same path twice adds nothing).
//
// Each push also pushes a new browser-history entry, so the browser's Back /
// Forward buttons walk the focus history in lock-step with the toolbar's.
export function pushStructureFocus(path) {
  if (!path) return;
  const stack = state.structureFocusStack;
  if (stack[stack.length - 1] === path) return;
  const next = [...stack, path];
  state.structureFocusStack = next;
  pushUrlState({ sessionId: state.selected, tab: state.activeTab, focusStack: next, structureAnchor: state.structureAnchor, structureHops: state.structureHops, structureMode: state.structureMode });
}

// "Back" — pop one level of focus and push the resulting URL so the browser's
// history stays aligned. The browser's Back button does the same thing through
// the popstate handler.
export function popStructureFocus() {
  const stack = state.structureFocusStack;
  if (stack.length === 0) return;
  const next = stack.slice(0, -1);
  state.structureFocusStack = next;
  pushUrlState({ sessionId: state.selected, tab: state.activeTab, focusStack: next, structureAnchor: state.structureAnchor, structureHops: state.structureHops, structureMode: state.structureMode });
}

export function clearStructureFocus() {
  if (state.structureFocusStack.length === 0) return;
  state.structureFocusStack = [];
  pushUrlState({ sessionId: state.selected, tab: state.activeTab, focusStack: [], structureAnchor: state.structureAnchor, structureHops: state.structureHops });
}

// Set the Structure tab's anchor to a specific file (called from the Files /
// Diff tabs' "Show in Structure" buttons). Switches the active tab to
// Structure, clears any focus stack (the new graph is unrelated to the old
// one), and triggers a refetch so the canvas redraws.
export async function setStructureAnchor(path) {
  if (!state.selected || !path) return;
  state.structureAnchor = { kind: "file", path };
  state.structureFocusStack = [];
  state.structureLoaded = false;
  state.structureBeforeLoaded = false;
  state.callGraphLoaded = false;
  state.callGraphBeforeLoaded = false;
  if (state.activeTab !== "structure") {
    await switchTab("structure");
  } else {
    pushUrlState({
      sessionId: state.selected, tab: "structure", focusStack: [],
      structureAnchor: state.structureAnchor, structureHops: state.structureHops,
      structureMode: state.structureMode,
    });
    await reloadActiveStructure();
  }
}

// Symbol-anchored counterpart to setStructureAnchor: pins the call graph to a
// specific function (path + 1-based line, optionally with the LSP character
// for an exact match). Triggered from the code-nav popover's "Show in
// Structure" entry; flips the Structure tab into function mode since that's
// what symbol anchoring is built for.
export async function setStructureSymbolAnchor(path, line, character) {
  if (!state.selected || !path || typeof line !== "number") return;
  state.structureAnchor = { kind: "symbol", path, line, character: typeof character === "number" ? character : undefined };
  state.structureMode = "function";
  state.structureFocusStack = [];
  state.structureLoaded = false;
  state.structureBeforeLoaded = false;
  state.callGraphLoaded = false;
  state.callGraphBeforeLoaded = false;
  if (state.activeTab !== "structure") {
    await switchTab("structure");
  } else {
    pushUrlState({
      sessionId: state.selected, tab: "structure", focusStack: [],
      structureAnchor: state.structureAnchor, structureHops: state.structureHops,
      structureMode: "function",
    });
    await reloadActiveStructure();
  }
}

export async function clearStructureAnchor() {
  if (!state.structureAnchor) return;
  state.structureAnchor = null;
  state.structureFocusStack = [];
  state.structureLoaded = false;
  state.structureBeforeLoaded = false;
  state.callGraphLoaded = false;
  state.callGraphBeforeLoaded = false;
  pushUrlState({
    sessionId: state.selected, tab: state.activeTab, focusStack: [],
    structureAnchor: null, structureHops: state.structureHops,
    structureMode: state.structureMode,
  });
  await reloadActiveStructure();
}

// User chose a new neighbourhood radius from the Structure toolbar. `hops` is
// a small integer (the UI exposes 1–4) or null to mean "server default" (2;
// DEFAULT_NEIGHBORHOOD_HOPS in src/structure-view.ts). The call-graph
// endpoint ignores hops (it always walks one hop), so we only re-fetch the
// import graph.
export async function setStructureHops(hops) {
  if (state.structureHops === hops) return;
  state.structureHops = hops;
  state.structureLoaded = false;
  state.structureBeforeLoaded = false;
  pushUrlState({
    sessionId: state.selected, tab: state.activeTab, focusStack: state.structureFocusStack,
    structureAnchor: state.structureAnchor, structureHops: hops,
    structureMode: state.structureMode,
  });
  if (state.activeTab === "structure") await ensureStructureViewLoaded(true);
}

// The Structure tab's Before / After split toggle. Pure visibility — the
// Before payload is fetched eagerly alongside After whenever the tab is
// active, so the canvas is already loaded by the time the human flips this.
export function setStructureSplit(enabled) {
  state.structureSplit = !!enabled;
}

async function reloadActiveStructure() {
  // Refetch After + Before for the active mode so anchor / hops / mode
  // changes show up everywhere immediately. The other mode is invalidated at
  // the call site and will refetch the next time the user flips the toggle.
  await ensureStructureViewLoaded(true);
}

// Applied when the browser fires popstate (back / forward, or a hashchange-ish
// programmatic navigation). The URL is already where the browser put it; we
// only need to bring the in-memory state in line with it. Selection and tab
// switches go through their public handlers with historyAction "none" so they
// don't push another entry onto an already-fired navigation.
export async function applyUrlState({ sessionId, tab, focusStack, structureAnchor, structureHops, structureMode }) {
  if (sessionId && sessionId !== state.selected) {
    await selectSession(sessionId, { historyAction: "none" });
  }
  const targetTab = tab || "reports";
  if (targetTab !== state.activeTab) {
    await switchTab(targetTab, { historyAction: "none" });
  }
  state.structureFocusStack = focusStack ?? [];
  const prevAnchorKey = anchorKey(state.structureAnchor);
  const nextAnchorKey = anchorKey(structureAnchor);
  const anchorChanged = prevAnchorKey !== nextAnchorKey;
  const hopsChanged = state.structureHops !== (structureHops ?? null);
  const targetMode = structureMode === "function" ? "function" : "file";
  const modeChanged = state.structureMode !== targetMode;
  state.structureAnchor = structureAnchor ?? null;
  state.structureHops = structureHops ?? null;
  state.structureMode = targetMode;
  if ((anchorChanged || hopsChanged || modeChanged) && state.activeTab === "structure") {
    state.structureLoaded = false;
    state.structureBeforeLoaded = false;
    state.callGraphLoaded = false;
    state.callGraphBeforeLoaded = false;
    await reloadActiveStructure();
  }
}

function anchorKey(anchor) {
  if (!anchor || !anchor.path) return "";
  if (anchor.kind === "symbol") return `s:${anchor.path}:${anchor.line ?? ""}`;
  return `f:${anchor.path}`;
}

// An anchor whose path is `./.worqload-reports/<filename>` points at a line in
// that report's markdown rather than at a worktree file.
const REPORTS_ANCHOR_PREFIX = "./.worqload-reports/";

// "Go to anchor" from a feedback anchor chip: open the tab that holds the
// anchored content, make sure the row is visible (expand the report / un-collapse
// the diff file), then hand DetailBody the request to scroll there and flash it.
// A worktree path is tried against the diff first (where most anchored feedback
// originates) and falls back to the Files tab.
export async function gotoAnchorTarget(path, lineStart, lineEnd) {
  if (!path) return;
  const target = { anchor: { path, lineStart, lineEnd: lineEnd || lineStart } };
  if (path.startsWith(REPORTS_ANCHOR_PREFIX)) {
    const filename = path.slice(REPORTS_ANCHOR_PREFIX.length);
    if (!state.reports.some(r => r.filename === filename)) { toast("anchor target not in this session"); return; }
    state.reportToggle = new Map(state.reportToggle).set(filename, true);
    await switchTab("reports");
    state.pendingScrollTo = target;
    return;
  }
  // Refresh both listings first so a stale view — or one that was never opened —
  // doesn't hide the target.
  await refreshDiff();
  if (parseDiffFiles(state.diff).some(f => f.path === path)) {
    if (state.collapsedFiles.has(path)) {
      const next = new Set(state.collapsedFiles);
      next.delete(path);
      state.collapsedFiles = next;
    }
    await switchTab("diff");
    state.pendingScrollTo = target;
    return;
  }
  await ensureFilesLoaded(true);
  if (state.files.includes(path)) {
    await switchTab("files");
    await selectFile(path);
    state.pendingScrollTo = target;
    return;
  }
  toast(`anchor target not in view: ${path}`);
}

// "Go to" the report or feedback article with the given filename: open its tab,
// expand it, and have DetailBody scroll it into view and flash it. Used by the
// report↔feedback reply-link chips.
export async function gotoArticle(tab, filename) {
  if (!filename) return;
  if (tab === "reports") {
    if (!state.reports.some(r => r.filename === filename)) { toast(`report not in this session: ${filename}`); return; }
    state.reportToggle = new Map(state.reportToggle).set(filename, true);
    await switchTab("reports");
    state.pendingScrollTo = { article: { attr: "data-report-filename", value: filename } };
  } else {
    if (!state.feedbackHistory.some(f => f.filename === filename)) { toast(`feedback not in this session: ${filename}`); return; }
    state.feedbackToggle = new Map(state.feedbackToggle).set(filename, true);
    await switchTab("feedback");
    state.pendingScrollTo = { article: { attr: "data-feedback-filename", value: filename } };
  }
}

// Jump the detail pane to a specific report — the action behind a desktop
// notification click. Selects the report's session if it isn't the one on
// screen, switches to the Reports tab, forces the report expanded (a click from
// a notification means "show me this now", overriding a collapse or a read
// mark), and scrolls it into view: a report that arrived over the websocket sits
// where the scroll anchor left it (see DetailBody.svelte), which may be
// off-screen. `filename` is null for the per-session-poll notifications, which
// only know a session gained unread reports — then just open the Reports tab.
export async function revealReport(sessionId, filename) {
  if (sessionId && sessionId !== state.selected) await selectSession(sessionId);
  await switchTab("reports");
  if (!filename) return;
  state.reportToggle = new Map(state.reportToggle).set(filename, true);
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = document.querySelector(`[data-report-filename="${CSS.escape(filename)}"]`);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
  }));
}

// Sidebar tab switch: flips the visible feed between active sessions and the
// archived list. Polling stays on whichever tab is shown (so the archived view
// keeps up with newly archived sessions / deletions). The selected session id
// is preserved across tab flips — an archived card in the detail pane stays
// readable while the human browses the active list. The bulk-delete selection
// is per-archived-visit: leaving the tab drops it.
export async function onSidebarTab(tab) {
  if (tab !== "active" && tab !== "archived") return;
  if (state.sidebarTab === tab) return;
  state.sidebarTab = tab;
  if (tab !== "archived" && state.archivedSelection.size > 0) {
    state.archivedSelection = new Set();
  }
  if (tab === "archived") {
    await fetchArchivedSessions();
  } else {
    await fetchSessions();
  }
}

// Left-sidebar visibility toggle. The flag drives a class on .layout
// (main.ts mirrors state.sidebarHidden onto the DOM) and is persisted in
// localStorage so the preference survives reloads — same pattern as the
// notification bell.
export const SIDEBAR_HIDDEN_KEY = "worqload:sidebar-hidden";

export function toggleSidebar() {
  state.sidebarHidden = !state.sidebarHidden;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, state.sidebarHidden ? "1" : "0");
  }
}

// Multi-select checkbox toggle in the archived feed. The selection drives the
// bulk-delete bar in SessionList.svelte. Reassigning the Set wholesale rather
// than mutating it lets Svelte 5's $state notice the change (it doesn't proxy
// Sets, so an in-place add/delete would go unnoticed).
export function onToggleArchivedSelection(id) {
  if (!id) return;
  const next = new Set(state.archivedSelection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  state.archivedSelection = next;
}

export function onSelectAllArchived() {
  state.archivedSelection = new Set(state.archivedSessions.map(s => s.id));
}

export function onClearArchivedSelection() {
  if (state.archivedSelection.size === 0) return;
  state.archivedSelection = new Set();
}

// Permanent delete from the archived tab. Confirms first (no undo: the
// worktree, the working branch, and the session dir all go), then calls the
// backend DELETE. On success the archived feed is reloaded; if the detail pane
// was showing this session, the selection is cleared.
export async function onDeleteArchived(id = state.selected) {
  if (!id) return;
  const session = state.archivedSessions.find(s => s.id === id) || state.sessions.find(s => s.id === id);
  const label = session?.title || session?.prompt?.slice(0, 40) || id;
  const message = `「${label}」を削除します。\nworktree・作業ブランチ・このセッションの記録 (reports / events / feedback) が消え、復元できません。よろしいですか？`;
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(message)) return;
  try {
    await api("DELETE", `/sessions/${id}`);
    if (state.archivedSelection.has(id)) {
      const nextSel = new Set(state.archivedSelection);
      nextSel.delete(id);
      state.archivedSelection = nextSel;
    }
    await fetchArchivedSessions();
    if (id === state.selected) {
      await selectSession(null);
    }
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// Bulk delete every checkbox-selected archived session. The DELETEs run
// sequentially rather than via Promise.all: each removes a git worktree from
// the same repo, and parallelising those would risk index-lock contention.
// One failed delete doesn't abort the batch — the surviving sessions still go,
// and the toast reports successes / failures at the end.
export async function onBulkDeleteArchived() {
  const ids = [...state.archivedSelection];
  if (ids.length === 0) return;
  const message = `${ids.length} 件のアーカイブを削除します。\nworktree・作業ブランチ・記録 (reports / events / feedback) が消え、復元できません。よろしいですか？`;
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(message)) return;
  let succeeded = 0;
  const failed = [];
  for (const id of ids) {
    try {
      await api("DELETE", `/sessions/${id}`);
      succeeded++;
      if (id === state.selected) state.selected = null;
    } catch (e) {
      failed.push({ id, message: e.message });
    }
  }
  state.archivedSelection = new Set();
  await fetchArchivedSessions();
  if (failed.length === 0) {
    toast(`${succeeded} 件削除`);
  } else if (succeeded === 0) {
    toast(`削除失敗: ${failed[0].message}`);
  } else {
    toast(`${succeeded} 件削除 / ${failed.length} 件失敗`);
  }
}

export async function onArchive(id = state.selected) {
  if (!id) return;
  try {
    // fetch directly (not api()): a 409 here carries a structured body the
    // confirm flow below reads — api() would fold the body into an Error
    // message and lose the fields.
    let res = await fetch(`/sessions/${id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      if (body.error === "preview-running") {
        const where = body.url ? `\n${body.url}` : "";
        const ok = window.confirm(`このセッションには動作中の Preview があります${where}\nPreview を停止して archive しますか？`);
        if (!ok) return;
        res = await fetch(`/sessions/${id}/archive?stopPreview=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
      }
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST /sessions/${id}/archive → ${res.status}: ${text}`);
    }
    await fetchSessions();
    // Archiving the session in the detail pane empties it — move to the first
    // session left, or an empty pane. Archiving some other card via its hover
    // button leaves the current selection (and the pane) untouched.
    if (id === state.selected) {
      const next = state.sessions.find(s => s.id !== id);
      await selectSession(next ? next.id : null);
    }
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// Reverse of onArchive — used by the "Unarchive" button on archived cards.
// Drops the bulk-delete checkbox state for this id (the card is about to leave
// the archived feed) and refreshes both lists so the session reappears in the
// active sidebar.
export async function onUnarchive(id = state.selected) {
  if (!id) return;
  try {
    await api("POST", `/sessions/${id}/unarchive`, {});
    if (state.archivedSelection.has(id)) {
      const nextSel = new Set(state.archivedSelection);
      nextSel.delete(id);
      state.archivedSelection = nextSel;
    }
    await fetchArchivedSessions();
    await fetchSessions();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// Disable every button in the asking article (and show "Sending…" on the one
// the human clicked) while its resolve request is in flight, so a second click
// can't fire a duplicate POST. On success refreshDetail tears the article down;
// on failure the returned restore() re-enables it for a retry.
function lockAskingArticle(articleEl, activeButton) {
  const buttons = articleEl ? [...articleEl.querySelectorAll("button")] : [];
  const activeLabel = activeButton ? activeButton.textContent : null;
  for (const b of buttons) b.disabled = true;
  if (activeButton) activeButton.textContent = "Sending…";
  return () => {
    for (const b of buttons) b.disabled = false;
    if (activeButton) activeButton.textContent = activeLabel;
  };
}

export async function onResolve(filename, articleEl, buttonEl) {
  if (!state.selected) return;
  const text = articleEl.querySelector(".ask-answer").value.trim();
  if (text === "") { toast("answer is required"); return; }
  const restore = lockAskingArticle(articleEl, buttonEl);
  try {
    await api("POST", `/sessions/${state.selected}/escalations/${encodeURIComponent(filename)}/resolve`, { content: text });
    toast("answer sent");
    await refreshDetail();
    await fetchSessions();
  } catch (e) {
    restore();
    toast(`failed: ${e.message}`);
  }
}

// Resolve a command-approval escalation: the human either approves (the server
// runs the command and feeds back its output) or rejects it. Any text typed
// into the article's textarea is relayed to the agent — as the human's note in
// the approve feedback, or as the reason in the reject feedback.
export async function onResolveCommand(filename, decision, articleEl, buttonEl) {
  if (!state.selected) return;
  const body = { decision };
  const note = articleEl?.querySelector(".ask-answer")?.value.trim() ?? "";
  if (note !== "") body.content = note;
  const restore = lockAskingArticle(articleEl, buttonEl);
  try {
    const res = await api("POST", `/sessions/${state.selected}/escalations/${encodeURIComponent(filename)}/resolve`, body);
    toast(decision === "approve" ? `command ran (exit ${res.exitCode ?? "?"})` : "command rejected");
    await refreshDetail();
    await fetchSessions();
  } catch (e) {
    restore();
    toast(`failed: ${e.message}`);
  }
}

export async function onFeedback(inputId = "feedbackInput") {
  if (!state.selected) return;
  const inputEl = $("#" + inputId);
  if (!inputEl) return;
  const text = inputEl.value.trim();
  const attachments = state.pendingAttachments;
  // Plain feedback needs body text. A composer that only has attachments still
  // needs a one-line note from the human; require at least one of the two.
  if (text === "" && attachments.length === 0) return;
  const body = { content: text, slug: state.anchor ? "anchored" : "feedback" };
  if (state.anchor) {
    body.anchor = {
      path: state.anchor.path,
      lineStart: state.anchor.lineStart,
      lineEnd: state.anchor.lineEnd,
    };
  }
  // Clear the textarea synchronously on submit, before the network round-trip:
  // submitting feedback writes a feedback_received event that the session's
  // WebSocket replays as a refreshDetail-driven re-render, and a clear that ran
  // after the await could be stranded by that re-render — the same race fixed
  // for the resume prompt.
  inputEl.value = "";
  let feedbackPosted = false;
  try {
    await submitFeedback(state.selected, body, attachments);
    feedbackPosted = true;
    state.anchor = null;
    clearAttachments();
    // Stay on whatever tab the human was reading (often the diff/file/report the
    // anchor points at): the sent feedback now shows at its anchor and in the
    // Feedbacks tab, so yanking the view away to the list is just disruptive.
    toast("feedback queued");
    await refreshDetail();
  } catch (e) {
    // Restore the captured text only if submitFeedback itself failed AND the
    // user hasn't typed something new while the request was in flight. A
    // refreshDetail failure after a successful submit must not drag the text
    // back — the feedback was sent.
    if (!feedbackPosted && inputEl.value === "") inputEl.value = text;
    toast(`failed: ${e.message}`);
  }
}

// --- composer attachment management (paste/drop image chips) ---------------
// Two composers (the bottom-fixed one and the floating anchored one) share
// `state.pendingAttachments`. Whichever submits sends the queued files; the
// other empties when the submit clears them. selectSession also clears the
// list so attachments don't leak across sessions.

let nextAttachmentId = 0;

// True when this File looks like a usable attachment to the server. The browser
// sets `type` from the clipboard/drag data; an empty type means we couldn't
// confirm the MIME and shouldn't gamble.
function isAcceptableAttachmentFile(file) {
  return ATTACHMENT_ALLOWED_MIMES.has(file.type);
}

// Ingest a list of File objects (from a paste, drop, or file picker). Skips
// files that don't pass the MIME / size checks and toasts what was rejected so
// the human knows. The per-feedback count cap is enforced together with what
// is already staged.
export function addAttachmentFiles(files) {
  const additions = [];
  for (const file of files) {
    if (state.pendingAttachments.length + additions.length >= ATTACHMENT_MAX_COUNT) {
      toast(`max ${ATTACHMENT_MAX_COUNT} attachments per feedback`);
      break;
    }
    if (!isAcceptableAttachmentFile(file)) {
      toast(`skipped ${file.name || "(unnamed)"}: not an allowed image type`);
      continue;
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      toast(`skipped ${file.name}: exceeds ${Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MiB`);
      continue;
    }
    additions.push({
      id: ++nextAttachmentId,
      file,
      previewUrl: URL.createObjectURL(file),
    });
  }
  if (additions.length === 0) return;
  state.pendingAttachments = [...state.pendingAttachments, ...additions];
}

export function removeAttachment(id) {
  const next = [];
  for (const att of state.pendingAttachments) {
    if (att.id === id) {
      try { URL.revokeObjectURL(att.previewUrl); } catch { /* already revoked */ }
    } else {
      next.push(att);
    }
  }
  state.pendingAttachments = next;
}

export function clearAttachments() {
  if (state.pendingAttachments.length === 0) return;
  for (const att of state.pendingAttachments) {
    try { URL.revokeObjectURL(att.previewUrl); } catch { /* already revoked */ }
  }
  state.pendingAttachments = [];
}

// Composer paste handler: pull every image out of the clipboard. Returns true
// when at least one image was ingested, so the caller can preventDefault to
// stop the browser also pasting the binary as garbage text.
export function onComposerPaste(event) {
  const items = event.clipboardData?.items;
  if (!items || items.length === 0) return false;
  const files = [];
  for (const item of items) {
    if (item.kind === "file" && typeof item.getAsFile === "function") {
      const f = item.getAsFile();
      if (f && ATTACHMENT_ALLOWED_MIMES.has(f.type)) files.push(f);
    }
  }
  if (files.length === 0) return false;
  event.preventDefault();
  addAttachmentFiles(files);
  return true;
}

// Composer drop handler: take any image files dropped on the composer.
export function onComposerDrop(event) {
  const dt = event.dataTransfer;
  if (!dt || !dt.files || dt.files.length === 0) return false;
  const files = [];
  for (const f of dt.files) {
    if (ATTACHMENT_ALLOWED_MIMES.has(f.type)) files.push(f);
  }
  if (files.length === 0) return false;
  event.preventDefault();
  addAttachmentFiles(files);
  return true;
}

// The floating composer that surfaces next to an anchored line/block (so the
// human doesn't have to track the cursor down to the bottom-fixed composer
// after anchoring). It has its own textarea id; otherwise identical to
// onFeedback.
export function onAnchoredFeedback() {
  return onFeedback("anchoredFeedbackInput");
}

export async function onStop(id = state.selected) {
  if (!id) return;
  try {
    await api("POST", `/sessions/${id}/stop`, {});
    if (id === state.selected) await refreshDetail();
    await fetchSessions();
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// The "wrap up this session" gesture: clear every unread-report badge, then
// stop the session — the two steps the human was otherwise doing by hand
// (mark each report read, then Stop in the sidebar).
export async function onStopAndMarkRead(id = state.selected) {
  if (!id) return;
  try {
    await api("POST", `/sessions/${id}/reports/read-all`, {});
    await api("POST", `/sessions/${id}/stop`, {});
    if (id === state.selected) await refreshDetail();
    await fetchSessions();
    toast("session stopped · all reports marked read");
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

export async function onResume(id = state.selected) {
  if (!id) return;
  // The composer textarea holds a prompt for the session shown in the detail
  // pane; resuming a different card from its hover button carries no prompt.
  const input = id === state.selected ? $("#feedbackInput") : null;
  const prompt = input ? input.value.trim() : "";
  // Clear synchronously on submit, so the textarea visibly empties before the
  // network round-trip — and so a re-render driven by the session_resumed WS
  // event (which arrives between the POST and the post-await clear that used
  // to live here) can't leave the user's prompt sitting in the textarea.
  if (input) input.value = "";
  let resumePosted = false;
  try {
    await api("POST", `/sessions/${id}/resume`, prompt ? { prompt } : {});
    // Past this point the resume has committed server-side; refreshDetail /
    // fetchSessions are best-effort UI follow-ups whose failures must NOT drag
    // the captured prompt back into the textarea — that's the bug the human
    // saw as "Resume したのに textarea が残る".
    resumePosted = true;
    toast("session resumed");
    if (id === state.selected) await refreshDetail();
    await fetchSessions();
  } catch (e) {
    // Restore only if the POST itself failed AND the user hasn't typed
    // something new while the request was in flight.
    if (!resumePosted && input && input.value === "") input.value = prompt;
    toast(`failed: ${e.message}`);
  }
}

// Recovery for a wedged RUNNING session: stop the host and immediately resume
// it via `claude --continue`. Replaces the previous "Wake" stdin nudge, which
// could only no-op when the host attachment was already gone.
export async function onStopAndResume(id = state.selected) {
  if (!id) return;
  const input = id === state.selected ? $("#feedbackInput") : null;
  const prompt = input ? input.value.trim() : "";
  // Same as onResume: clear before the awaits. The stop + resume sequence
  // emits two WS events back-to-back, so the window for a re-render between
  // capture and clear is wider.
  if (input) input.value = "";
  let resumePosted = false;
  try {
    await api("POST", `/sessions/${id}/stop`, {});
    await api("POST", `/sessions/${id}/resume`, prompt ? { prompt } : {});
    // Resume POST committed; subsequent refresh/fetch failures must not put
    // the prompt back into the textarea (see onResume for the rationale).
    resumePosted = true;
    toast("session stopped & resumed");
    if (id === state.selected) await refreshDetail();
    await fetchSessions();
  } catch (e) {
    if (!resumePosted && input && input.value === "") input.value = prompt;
    toast(`failed: ${e.message}`);
  }
}

// Inline rename of a session's display title (the "alias"). The sidebar/detail
// title defaults to the head of the initial prompt, which reads as the user's
// opening message and is hard to tell sessions apart by; a short alias fixes
// that. A blank value clears the alias and reinstates the prompt-head fallback.
export function onRenameStart(id) {
  if (!id) return;
  state.renamingSessionId = id;
}

export function onRenameCancel() {
  if (!state.renamingSessionId) return;
  state.renamingSessionId = null;
}

export async function onRenameCommit(id, rawValue) {
  // Guard against a second invocation: pressing Enter commits and a `blur`
  // (when the re-render removes the input, or focus moves away) would call this
  // again — by then renamingSessionId no longer matches and we no-op.
  if (state.renamingSessionId !== id) return;
  state.renamingSessionId = null;
  const title = (rawValue ?? "").trim();
  const card = state.sessions.find(s => s.id === id);
  if (title === ((card && card.title) || "")) return;
  try {
    const { meta } = await api("POST", `/sessions/${id}/title`, { title });
    if (card) card.title = meta.title;
    if (state.detail && state.detail.meta && state.detail.meta.id === id) state.detail.meta = meta;
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// The detail-header toggle for revise mode. The flag lives on the session meta
// (absent means off); flipping it changes whether worqload bounces the first
// submission of this session's future reports back for a revision pass. Reads
// the current value off the loaded detail (where the toggle is rendered) and
// sends the inverse — only an explicit true counts as on.
export async function onToggleReviseMode(id) {
  if (!id) return;
  const meta = state.detail && state.detail.meta && state.detail.meta.id === id ? state.detail.meta : null;
  if (!meta) return;
  const enabled = meta.reviseModeEnabled !== true;
  try {
    const res = await api("POST", `/sessions/${id}/revise-mode`, { enabled });
    state.detail.meta = res.meta;
    const card = state.sessions.find(s => s.id === id);
    if (card) card.reviseModeEnabled = res.meta.reviseModeEnabled;
  } catch (e) {
    toast(`failed: ${e.message}`);
  }
}

// Drag-reorder the sidebar: move the dragged card so it lands immediately
// before `beforeId` (or to the end when that's null), update the in-browser
// list at once, then persist so the 30s poll keeps the new order.
export async function onReorderSessions(draggedId, beforeId) {
  if (!draggedId || draggedId === beforeId) return;
  const next = state.sessions.slice();
  const from = next.findIndex(s => s.id === draggedId);
  if (from === -1) return;
  const [moved] = next.splice(from, 1);
  const to = beforeId === null ? next.length : next.findIndex(s => s.id === beforeId);
  next.splice(to === -1 ? next.length : to, 0, moved);
  state.sessions = next;
  try {
    await reorderSessions(next.map(s => s.id));
  } catch (e) {
    toast(`failed: ${e.message}`);
    await fetchSessions();
  }
}

export function toggleActionPanel(actionId) {
  if (!actionId) return;
  state.openActionId = state.openActionId === actionId ? null : actionId;
}

// Pulls the pull-request URL out of the create-pr run log. `gh pr create`
// prints the URL on its own line; the run log wraps it with the shell-style
// command echoes, so scan for the last GitHub-style `.../pull/<n>` URL (works
// for github.com and GHES alike).
export function extractPullRequestUrl(stdout) {
  const matches = stdout.match(/https?:\/\/\S+\/pull\/\d+/g);
  return matches ? matches[matches.length - 1] : null;
}

export function extractPreviewUrl(stdout) {
  const match = stdout.match(/listening on (https?:\/\/\S+)/);
  return match ? match[1] : null;
}

// How long to wait between re-issue attempts after an idempotent action's
// request is severed, and how many to make. The dev server's `bun --watch`
// restart rebinds the same port within ~1s; 20 × 300ms covers a slow machine
// without hanging the button indefinitely if the server is genuinely down.
const ACTION_RECONNECT_RETRY_MS = 300;
const ACTION_RECONNECT_MAX_ATTEMPTS = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postAction(action, params) {
  const res = await fetch(`/sessions/${state.selected}/actions/${encodeURIComponent(action.id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ params }),
  });
  return res.json().catch(() => ({}));
}

// `serve --watch` restarts the server when an action rewrites its own source
// tree (merge-to-base's `git merge`, sync-base's `git pull`), dropping this
// request even though the git work already completed on disk. For an
// idempotent action, wait out the restart — it rebinds the same port — and
// re-issue: the re-run reports the already-done state ("Already up to date.")
// instead of the phantom "Failed to fetch" the user otherwise sees once and
// then clicks past on a second try. A non-idempotent action (create-pr) must
// not be replayed, so its network error propagates unchanged.
async function fetchActionResult(action, params) {
  try {
    return await postAction(action, params);
  } catch (netError) {
    if (!action.idempotent) throw netError;
    for (let attempt = 0; attempt < ACTION_RECONNECT_MAX_ATTEMPTS; attempt++) {
      await sleep(ACTION_RECONNECT_RETRY_MS);
      try {
        return await postAction(action, params);
      } catch {
        /* server still restarting; keep waiting for it to rebind the port */
      }
    }
    throw netError;
  }
}

// POSTs an action invocation, records its result, and surfaces it (toast, and
// for create-pr / preview opens the resulting URL). Shared by the inline panel
// (runOpenAction) and the direct header buttons (runDirectAction).
async function runAction(action, params) {
  if (!state.selected) return;
  // create-pr ends by opening the freshly created PR. window.open is honoured
  // only while the click's transient activation is live (~5s in Chrome), and
  // create-pr's `git push` + `gh pr create` routinely runs longer than that (a
  // pre-push hook running a test suite pushes it well past) — so a window.open
  // issued after `await fetchActionResult` is swallowed by the popup blocker.
  // Open a blank tab now, synchronously on the click, and either point it at
  // the PR or close it once the run resolves. `noopener` would make
  // window.open return null, so the opener link is severed by hand instead.
  const prTab = action.id === "create-pr" ? window.open("", "_blank") : null;
  if (prTab) prTab.opener = null;
  state.actionRunInFlight = true;
  state.runningActionId = action.id;
  try {
    const data = await fetchActionResult(action, params);
    // actionResults is reassigned wholesale rather than mutated: Svelte 5's
    // $state doesn't proxy Maps, so ActionBar only re-renders the run output
    // when the property itself is replaced.
    state.actionResults = new Map(state.actionResults).set(action.id, {
      ok: !!data.ok,
      exitCode: data.exitCode ?? null,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      message: data.message,
      ranAt: new Date().toISOString(),
    });
    if (data.ok && action.id === "create-pr") {
      // The branch just got a PR; bypass the server cache so the link appears
      // now instead of after its TTL.
      if (state.selected) void loadPrLink(state.selected, { fresh: true });
      const url = extractPullRequestUrl(data.stdout ?? "");
      if (url) {
        // `gh pr create` already did the work; jumping straight to the PR is
        // the next thing the user wants. Navigate the tab opened on the click;
        // if that open was itself blocked, fall back to opening it now.
        if (prTab) prTab.location = url;
        else window.open(url, "_blank", "noopener");
        toast(`PR created: ${url}`);
      } else {
        if (prTab) prTab.close();
        toast(`${action.label}: success`);
      }
    } else if (data.ok && action.id === "preview") {
      const url = extractPreviewUrl(data.stdout ?? "");
      if (url) {
        // The preview server is up; open it. A popup blocker may swallow this
        // (it fires after the fetch, not directly on the click) — the URL also
        // shows in the run output / Events.
        window.open(url, "_blank", "noopener");
        toast(`Preview running: ${url}`);
      } else {
        toast(`${action.label}: started`);
      }
    } else if (data.ok) {
      toast(data.message || `${action.label}: success`);
    } else {
      if (prTab) prTab.close();
      toast(`${action.label}: ${data.message || "failed"}`);
    }
  } catch (e) {
    if (prTab) prTab.close();
    state.actionResults = new Map(state.actionResults).set(action.id, { ok: false, exitCode: null, stdout: "", stderr: "", message: e.message, ranAt: new Date().toISOString() });
    toast(`failed: ${e.message}`);
  } finally {
    state.actionRunInFlight = false;
    state.runningActionId = null;
  }
}

export async function runOpenAction() {
  const action = state.actions.find(a => a.id === state.openActionId);
  if (!action || !state.selected) return;
  const params = {};
  for (const p of action.params || []) {
    const el = document.getElementById(`actionParam-${p.name}`);
    if (el) params[p.name] = el.value;
  }
  await runAction(action, params);
}

// A "direct" action's header button: run it immediately, no panel. Ignored
// while another action is in flight.
export async function runDirectAction(actionId) {
  if (state.actionRunInFlight) return;
  const action = state.actions.find(a => a.id === actionId);
  if (action) await runAction(action, {});
}

