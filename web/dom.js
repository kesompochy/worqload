// Small DOM / formatting helpers shared across the worqload frontend modules.

export const $ = (sel) => document.querySelector(sel);

export function toast(text, ms = 2400) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

// Wire a single-line edit input: a non-composing Enter commits, Escape cancels.
// IME composition is tracked explicitly: `event.isComposing` and
// `keyCode === 229` cover most browsers, but on some macOS browsers the
// commit-Enter keydown fires after compositionend with both flags clear, so
// the explicit flag is the backstop. (The browser's native prompt() has no
// such guard, so a confirming Enter mid-IME also "submits" the dialog; this
// avoids that.)
export function bindInlineEdit(input, { onCommit, onCancel }) {
  if (!input) return;
  let composing = false;
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("keydown", e => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
    if (e.key === "Enter") { e.preventDefault(); onCommit(); }
  });
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// `now` defaults to the wall clock; callers that want the label to tick (the
// Events UI) pass a reactive timestamp so Svelte re-derives once a second.
export function formatRelative(iso, now = Date.now()) {
  if (!iso) return "";
  const diff = (now - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// The Events tab-bar age label ("· Ns ago", the time since the newest streamed
// event) goes "stale" once that gap reaches a minute, so a session that has
// fallen quiet draws the eye. 60s is also where formatRelative stops counting
// in seconds, so the highlight lines up with the label switching to "Nm ago".
export const STALE_EVENT_AGE_MS = 60_000;

export function eventAgeIsStale(iso, now = Date.now()) {
  if (!iso) return false;
  return now - new Date(iso).getTime() >= STALE_EVENT_AGE_MS;
}

// The badge a session shows. A live session's status alone cannot tell an
// agent mid-turn from one that has finished its turn, or from one whose report
// is still being polished, so the badge also reads the agent's turn and the
// polish queue the server reports.
export function sessionBadge(session) {
  if (session.status === "stopped" || session.status === "crashed") return session.status;
  if (session.agentTurn === "working") return "running";
  if ((session.polishing?.length ?? 0) > 0) return "polishing";
  if (session.status === "waiting_human") return "waiting_human";
  return session.agentTurn === "idle" ? "idle" : session.status;
}

// Measured polishes took up to about a minute; one waiting 1.5 times that is
// likely stuck rather than slow.
export const POLISH_OVERDUE_MS = 90_000;

// How long the oldest draft has waited for its polish, or null when none waits.
export function polishWait(polishing, now = Date.now()) {
  if (!polishing || polishing.length === 0) return null;
  const oldest = Math.min(...polishing.map(p => new Date(p.since).getTime()));
  return { seconds: Math.floor((now - oldest) / 1000), overdue: now - oldest >= POLISH_OVERDUE_MS };
}

export const EVENT_COUNT_WARNING = 1000;
export const EVENT_COUNT_DANGER = 2000;

export function eventCountLevel(count) {
  if (count >= EVENT_COUNT_DANGER) return "danger";
  if (count >= EVENT_COUNT_WARNING) return "warning";
  return null;
}

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
