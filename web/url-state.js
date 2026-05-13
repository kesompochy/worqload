// Persists the selected session id and active tab into the query string with
// `history.replaceState`, so a page reload (frequent with `worqload serve
// --watch` + Vite hot-rebuilds) lands on the same view, and the URL is
// shareable across windows. Session Storage was the alternative; Query String
// wins because it survives tab close and is shareable.

const VALID_TABS = new Set(["reports", "feedback", "diff", "files", "structure", "events"]);
const DEFAULT_TAB = "reports";

export function readUrlState() {
  if (typeof window === "undefined" || !window.location) return { sessionId: null, tab: null };
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session");
  const tab = params.get("tab");
  return {
    sessionId: sessionId || null,
    tab: tab && VALID_TABS.has(tab) ? tab : null,
  };
}

export function syncUrlState({ sessionId, tab }) {
  if (typeof window === "undefined" || !window.history || !window.location) return;
  const params = new URLSearchParams(window.location.search);
  if (sessionId) params.set("session", sessionId);
  else params.delete("session");
  // The default tab is implicit — omitting it keeps the URL short for the most
  // common case (just `?session=<id>`).
  if (tab && tab !== DEFAULT_TAB) params.set("tab", tab);
  else params.delete("tab");
  const queryString = params.toString();
  const newUrl = `${window.location.pathname}${queryString ? `?${queryString}` : ""}${window.location.hash || ""}`;
  window.history.replaceState(null, "", newUrl);
}
