import { test, expect } from "bun:test";
import {
  headlineFromMarkdown,
  notificationForEvent,
  notificationsFromSessionPoll,
  pendingNotificationCount,
  sessionLabel,
} from "../web/notifications.js";

test("sessionLabel prefers the title, then a clipped prompt, then the id", () => {
  expect(sessionLabel({ id: "s1", title: "fix parser", prompt: "x" })).toBe("fix parser");
  expect(sessionLabel({ id: "s1", title: "  ", prompt: " add notifications " })).toBe("add notifications");
  const long = "do a very long thing ".repeat(10);
  expect(sessionLabel({ id: "s1", prompt: long }).length).toBe(80);
  expect(sessionLabel({ id: "s1" })).toBe("s1");
  expect(sessionLabel(null)).toBe("session");
});

test("headlineFromMarkdown drops an ATX heading marker", () => {
  expect(headlineFromMarkdown("# Plan formed\n\nbody", "001-plan.md")).toBe("Plan formed");
});

test("headlineFromMarkdown uses the first non-blank line of plain text", () => {
  expect(headlineFromMarkdown("\n\nstarting work now\nmore", "x.md")).toBe("starting work now");
});

test("headlineFromMarkdown drops wrapping emphasis and list markers", () => {
  expect(headlineFromMarkdown("**done**\n", "x.md")).toBe("done");
  expect(headlineFromMarkdown("- first task\n", "x.md")).toBe("first task");
});

test("headlineFromMarkdown falls back to the filename when there is no usable line", () => {
  expect(headlineFromMarkdown("   \n\n", "002-empty.md")).toBe("002-empty.md");
  expect(headlineFromMarkdown("***\n", "002-empty.md")).toBe("002-empty.md");
  expect(headlineFromMarkdown("", "002-empty.md")).toBe("002-empty.md");
  expect(headlineFromMarkdown(null, "002-empty.md")).toBe("002-empty.md");
});

test("notificationForEvent: report_submitted carries the report headline", () => {
  const n = notificationForEvent(
    { kind: "report_submitted", payload: { filename: "003-build-failed.md" } },
    {
      session: { id: "s1", title: "fix the parser" },
      reports: [{ filename: "003-build-failed.md", content: "# Build failed\n\ndetails" }],
      asking: [],
    },
  );
  expect(n).toEqual({
    sessionId: "s1",
    tag: "worqload:report:s1:003-build-failed.md",
    title: "fix the parser",
    body: "📄 Build failed",
  });
});

test("notificationForEvent: report_submitted with no matching report still notifies", () => {
  const n = notificationForEvent(
    { kind: "report_submitted", payload: { filename: "004-x.md" } },
    { session: { id: "s1", title: "t" }, reports: [], asking: [] },
  );
  expect(n?.body).toBe("📄 004-x.md");
});

test("notificationForEvent: escalation_requested carries the question headline", () => {
  const n = notificationForEvent(
    { kind: "escalation_requested", payload: { filename: "001-which-lib.md" } },
    {
      session: { id: "s2", title: "add notifications" },
      reports: [],
      asking: [{ filename: "001-which-lib.md", content: "Which markdown lib?\n\noptions..." }],
    },
  );
  expect(n).toEqual({
    sessionId: "s2",
    tag: "worqload:ask:s2:001-which-lib.md",
    title: "add notifications",
    body: "🙋 Which markdown lib?",
  });
});

test("notificationForEvent returns null for unrelated or missing events", () => {
  expect(
    notificationForEvent({ kind: "claude_tool_use", payload: {} }, { session: { id: "s" }, reports: [], asking: [] }),
  ).toBeNull();
  expect(notificationForEvent(null, {})).toBeNull();
});

test("notificationsFromSessionPoll ignores sessions absent from the previous snapshot", () => {
  const next = [{ id: "a", title: "A", status: "running", unreadReportCount: 3 }];
  expect(notificationsFromSessionPoll([], next, { selectedId: null })).toEqual([]);
});

test("notificationsFromSessionPoll notifies on a rising unread-report count", () => {
  const prev = [{ id: "a", title: "A", status: "running", unreadReportCount: 1 }];
  const next = [{ id: "a", title: "A", status: "running", unreadReportCount: 3 }];
  expect(notificationsFromSessionPoll(prev, next, { selectedId: null })).toEqual([
    { sessionId: "a", tag: "worqload:report:a", title: "A", body: "📄 2 new reports" },
  ]);
});

test("notificationsFromSessionPoll phrases a single new report naturally", () => {
  const prev = [{ id: "a", title: "A", status: "running", unreadReportCount: 0 }];
  const next = [{ id: "a", title: "A", status: "running", unreadReportCount: 1 }];
  expect(notificationsFromSessionPoll(prev, next, {})[0].body).toBe("📄 new report");
});

test("notificationsFromSessionPoll notifies when a session enters waiting_human", () => {
  const prev = [{ id: "a", title: "A", status: "running", unreadReportCount: 0 }];
  const next = [{ id: "a", title: "A", status: "waiting_human", unreadReportCount: 0 }];
  expect(notificationsFromSessionPoll(prev, next, {})).toEqual([
    { sessionId: "a", tag: "worqload:ask:a", title: "A", body: "🙋 waiting for your input" },
  ]);
});

test("notificationsFromSessionPoll skips the currently selected session", () => {
  const prev = [{ id: "a", title: "A", status: "running", unreadReportCount: 0 }];
  const next = [{ id: "a", title: "A", status: "waiting_human", unreadReportCount: 2 }];
  expect(notificationsFromSessionPoll(prev, next, { selectedId: "a" })).toEqual([]);
});

test("notificationsFromSessionPoll reports both a new report and a new wait at once", () => {
  const prev = [{ id: "a", title: "A", status: "running", unreadReportCount: 0 }];
  const next = [{ id: "a", title: "A", status: "waiting_human", unreadReportCount: 1 }];
  expect(notificationsFromSessionPoll(prev, next, {})).toEqual([
    { sessionId: "a", tag: "worqload:report:a", title: "A", body: "📄 new report" },
    { sessionId: "a", tag: "worqload:ask:a", title: "A", body: "🙋 waiting for your input" },
  ]);
});

test("pendingNotificationCount sums unread reports and waiting_human sessions", () => {
  const sessions = [
    { id: "a", status: "running", unreadReportCount: 2 },
    { id: "b", status: "waiting_human", unreadReportCount: 0 },
    { id: "c", status: "waiting_human", unreadReportCount: 1 },
    { id: "d", status: "stopped", unreadReportCount: 0 },
  ];
  expect(pendingNotificationCount(sessions)).toBe(2 + 1 + 1 + 1);
});

test("pendingNotificationCount is zero for no sessions or quiet sessions", () => {
  expect(pendingNotificationCount([])).toBe(0);
  expect(pendingNotificationCount(undefined)).toBe(0);
  expect(pendingNotificationCount([{ id: "a", status: "running", unreadReportCount: 0 }])).toBe(0);
});
