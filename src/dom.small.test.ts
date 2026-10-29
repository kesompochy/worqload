import { test, expect } from "bun:test";
import { escapeHtml, formatBytes, formatRelative, eventAgeIsStale, EVENT_COUNT_WARNING, EVENT_COUNT_DANGER, eventCountLevel, sessionBadge, polishWait, POLISH_OVERDUE_MS } from "../web/dom.js";

test("escapeHtml escapes the five HTML-significant characters", () => {
  expect(escapeHtml(`<a href="x" data-y='z'>&</a>`)).toBe(
    "&lt;a href=&quot;x&quot; data-y=&#39;z&#39;&gt;&amp;&lt;/a&gt;",
  );
});

test("escapeHtml coerces nullish to empty string", () => {
  expect(escapeHtml(null)).toBe("");
  expect(escapeHtml(undefined)).toBe("");
  expect(escapeHtml(0)).toBe("0");
});

test("formatBytes scales B / KB / MB", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1024)).toBe("1.0 KB");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
});

test("formatBytes returns empty for non-finite input", () => {
  expect(formatBytes(null)).toBe("");
  expect(formatBytes(undefined)).toBe("");
  expect(formatBytes(NaN)).toBe("");
});

test("formatRelative buckets by seconds / minutes / hours / days", () => {
  const now = Date.now();
  expect(formatRelative(new Date(now - 5_000).toISOString())).toBe("5s ago");
  expect(formatRelative(new Date(now - 90_000).toISOString())).toBe("1m ago");
  expect(formatRelative(new Date(now - 3 * 3600_000).toISOString())).toBe("3h ago");
  expect(formatRelative(new Date(now - 2 * 86400_000).toISOString())).toBe("2d ago");
});

test("formatRelative returns empty for missing timestamp", () => {
  expect(formatRelative(null)).toBe("");
  expect(formatRelative(undefined)).toBe("");
  expect(formatRelative("")).toBe("");
});

test("eventAgeIsStale flips once the timestamp is at least a minute old", () => {
  const now = Date.now();
  expect(eventAgeIsStale(new Date(now - 5_000).toISOString(), now)).toBe(false);
  expect(eventAgeIsStale(new Date(now - 59_999).toISOString(), now)).toBe(false);
  expect(eventAgeIsStale(new Date(now - 60_000).toISOString(), now)).toBe(true);
  expect(eventAgeIsStale(new Date(now - 5 * 60_000).toISOString(), now)).toBe(true);
});

test("eventAgeIsStale is false for missing timestamp", () => {
  expect(eventAgeIsStale(null, Date.now())).toBe(false);
  expect(eventAgeIsStale(undefined, Date.now())).toBe(false);
  expect(eventAgeIsStale("", Date.now())).toBe(false);
});

test("eventCountLevel returns null below warning threshold", () => {
  expect(eventCountLevel(0)).toBe(null);
  expect(eventCountLevel(EVENT_COUNT_WARNING - 1)).toBe(null);
});

test("eventCountLevel returns 'warning' at and above warning threshold", () => {
  expect(eventCountLevel(EVENT_COUNT_WARNING)).toBe("warning");
  expect(eventCountLevel(EVENT_COUNT_DANGER - 1)).toBe("warning");
});

test("eventCountLevel returns 'danger' at and above danger threshold", () => {
  expect(eventCountLevel(EVENT_COUNT_DANGER)).toBe("danger");
  expect(eventCountLevel(EVENT_COUNT_DANGER + 100)).toBe("danger");
});

test("sessionBadge tells an agent mid-turn from one that has finished its turn or awaits a polish", () => {
  expect(sessionBadge({ status: "running", agentTurn: "working", polishing: [] })).toBe("running");
  expect(sessionBadge({ status: "running", agentTurn: "idle", polishing: [] })).toBe("idle");
  expect(sessionBadge({ status: "running", agentTurn: "idle", polishing: [{ kind: "report", slug: "plan", since: "" }] })).toBe("polishing");
  // A polish running beside a working agent does not hide that the agent works.
  expect(sessionBadge({ status: "running", agentTurn: "working", polishing: [{ kind: "report", slug: "plan", since: "" }] })).toBe("running");
  expect(sessionBadge({ status: "waiting_human", agentTurn: "idle", polishing: [] })).toBe("waiting_human");
  expect(sessionBadge({ status: "waiting_human", agentTurn: "working", polishing: [] })).toBe("running");
});

test("sessionBadge keeps the lifecycle status for ended sessions and for sessions without turn data", () => {
  expect(sessionBadge({ status: "stopped", agentTurn: "working", polishing: [] })).toBe("stopped");
  expect(sessionBadge({ status: "crashed", agentTurn: "idle", polishing: [] })).toBe("crashed");
  expect(sessionBadge({ status: "running" })).toBe("running");
});

test("polishWait measures from the oldest waiting draft and flags one waiting too long", () => {
  const now = Date.parse("2026-10-29T00:02:00Z");
  const polishing = [
    { kind: "report", slug: "a", since: "2026-10-29T00:01:30Z" },
    { kind: "report", slug: "b", since: "2026-10-29T00:01:50Z" },
  ];
  expect(polishWait(polishing, now)).toEqual({ seconds: 30, overdue: false });
  expect(polishWait(polishing, Date.parse("2026-10-29T00:01:30Z") + POLISH_OVERDUE_MS)).toEqual({ seconds: 90, overdue: true });
  expect(polishWait([], now)).toBeNull();
  expect(polishWait(undefined, now)).toBeNull();
});
