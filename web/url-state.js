// Persists session/tab/focus-stack into the query string so the browser's
// back / forward buttons walk the user's navigation history, a reload (frequent
// with `worqload serve --watch` + Vite hot-rebuilds) lands on the same view,
// and the URL is shareable across windows.
//
// `pushUrlState` adds a new history entry (used for user-initiated navigation:
// selecting a session, switching a tab, drilling into a Structure focus).
// `replaceUrlState` overwrites the current entry without creating a back step
// (used on initial load when canonicalising the URL).

const VALID_TABS = new Set(["reports", "feedback", "diff", "files", "structure", "events"]);
const DEFAULT_TAB = "reports";

export function readUrlState() {
  if (typeof window === "undefined" || !window.location) return { sessionId: null, tab: null, focusStack: [] };
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session");
  const tab = params.get("tab");
  // `focus` is repeated per stack level — the bottom of the stack first, the
  // current focus last — so a URL stays human-readable as paths drill in.
  const focusStack = params.getAll("focus");
  return {
    sessionId: sessionId || null,
    tab: tab && VALID_TABS.has(tab) ? tab : null,
    focusStack,
  };
}

function buildUrl({ sessionId, tab, focusStack }) {
  // Seed from the live query string so unrelated params (e.g. `?theme=dark`
  // that some other layer set) survive across syncs. Only the three keys we
  // own — session, tab, focus — get rewritten.
  const params = new URLSearchParams(window.location.search);
  if (sessionId) params.set("session", sessionId);
  else params.delete("session");
  // The default tab is implicit — omitting it keeps the URL short for the most
  // common case (just `?session=<id>`).
  if (tab && tab !== DEFAULT_TAB) params.set("tab", tab);
  else params.delete("tab");
  params.delete("focus");
  for (const path of focusStack ?? []) {
    if (path) params.append("focus", path);
  }
  const queryString = params.toString();
  return `${window.location.pathname}${queryString ? `?${queryString}` : ""}${window.location.hash || ""}`;
}

function currentUrl() {
  return `${window.location.pathname}${window.location.search}${window.location.hash || ""}`;
}

export function replaceUrlState(state) {
  if (typeof window === "undefined" || !window.history || !window.location) return;
  window.history.replaceState(null, "", buildUrl(state));
}

export function pushUrlState(state) {
  if (typeof window === "undefined" || !window.history || !window.location) return;
  const next = buildUrl(state);
  // pushState always creates a new history entry, even when the URL is
  // identical — that would mean two browser-back clicks to leave the same
  // logical view. Collapse the no-op case to a replace.
  if (next === currentUrl()) {
    window.history.replaceState(null, "", next);
    return;
  }
  window.history.pushState(null, "", next);
}
