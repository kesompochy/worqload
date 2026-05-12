// Pure helpers for the worqload UI's desktop notifications.
//
// The browser-side glue (Notification permission, the bell toggle, actually
// calling `new Notification(...)`) lives in index.html. This module only
// answers "given what just changed, what should the toast say" so it can be
// unit-tested without a DOM.
//
// Two sources feed notifications:
//   - the per-session event stream (websocket) for the session the human is
//     currently viewing — see notificationForEvent;
//   - the periodic /sessions poll for every other session — see
//     notificationsFromSessionPoll.

const SESSION_LABEL_MAX = 80;

// A short, human-facing name for a session card: explicit title, else the head
// of the initial prompt, else the bare id.
export function sessionLabel(session) {
  if (!session) return "session";
  const title = (session.title ?? "").trim();
  if (title) return title;
  const prompt = (session.prompt ?? "").trim();
  if (prompt) return prompt.slice(0, SESSION_LABEL_MAX);
  return session.id || "session";
}

// First meaningful line of a markdown body (report / escalation), with a
// leading heading, list bullet, blockquote marker or wrapping emphasis
// stripped. Falls back to `fallback` (typically the filename) when the body
// has nothing usable.
export function headlineFromMarkdown(content, fallback) {
  const line = String(content ?? "")
    .split("\n")
    .map(s => s.trim())
    .find(s => s.length > 0);
  if (!line) return fallback;
  const cleaned = line
    .replace(/^#{1,6}\s+/, "")   // ATX heading marker
    .replace(/^[-*+>]\s+/, "")   // list bullet / blockquote marker
    .replace(/^[*_~`]+/, "")     // wrapping emphasis / code ticks (open)
    .replace(/[*_~`]+$/, "")     // wrapping emphasis / code ticks (close)
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

// Build the notification for one streamed event of the currently-selected
// session, or null when the event isn't worth surfacing. Context carries the
// session meta plus the freshly-refreshed reports / asking lists so the body
// can quote the report or question headline.
export function notificationForEvent(event, { session, reports = [], asking = [] } = {}) {
  if (!event) return null;
  const label = sessionLabel(session);
  const sessionId = session?.id;
  if (event.kind === "report_submitted") {
    const filename = event.payload?.filename || "";
    const report = reports.find(r => r.filename === filename);
    const headline = headlineFromMarkdown(report?.content, filename || "new report");
    return { sessionId, tag: `worqload:report:${sessionId}:${filename}`, title: label, body: `📄 ${headline}` };
  }
  if (event.kind === "escalation_requested") {
    const filename = event.payload?.filename || "";
    const ask = asking.find(a => a.filename === filename);
    const headline = headlineFromMarkdown(ask?.content, filename || "needs your input");
    return { sessionId, tag: `worqload:ask:${sessionId}:${filename}`, title: label, body: `🙋 ${headline}` };
  }
  return null;
}

// Compare two /sessions snapshots and return notifications for sessions that
// gained unread reports or newly entered waiting_human. The currently-selected
// session is skipped (its events arrive over the websocket) and a session not
// present in `prevSessions` is skipped too, so a page reload doesn't replay the
// backlog as a flood of toasts.
export function notificationsFromSessionPoll(prevSessions, nextSessions, { selectedId = null } = {}) {
  const prevById = new Map((prevSessions ?? []).map(s => [s.id, s]));
  const out = [];
  for (const s of nextSessions ?? []) {
    if (!s || s.id === selectedId) continue;
    const before = prevById.get(s.id);
    if (!before) continue;
    const label = sessionLabel(s);
    const prevUnread = Number(before.unreadReportCount) || 0;
    const nextUnread = Number(s.unreadReportCount) || 0;
    if (nextUnread > prevUnread) {
      const delta = nextUnread - prevUnread;
      out.push({
        sessionId: s.id,
        tag: `worqload:report:${s.id}`,
        title: label,
        body: delta === 1 ? "📄 new report" : `📄 ${delta} new reports`,
      });
    }
    if (s.status === "waiting_human" && before.status !== "waiting_human") {
      out.push({ sessionId: s.id, tag: `worqload:ask:${s.id}`, title: label, body: "🙋 waiting for your input" });
    }
  }
  return out;
}

// How many things across all sessions are waiting for the human: every unread
// report plus every session sitting in waiting_human. Used to prefix the
// browser tab title so the count shows even when the tab isn't focused.
export function pendingNotificationCount(sessions) {
  let count = 0;
  for (const s of sessions ?? []) {
    count += Number(s?.unreadReportCount) || 0;
    if (s?.status === "waiting_human") count += 1;
  }
  return count;
}
