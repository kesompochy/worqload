import { test, expect } from "bun:test";
import { escapeHtml, formatBytes, formatRelative, eventAgeIsStale } from "../web/dom.js";

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
