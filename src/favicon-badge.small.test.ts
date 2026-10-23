import { test, expect, beforeEach } from "bun:test";
import { buildBadgeDataUrl } from "../web/favicon-badge.js";

test("buildBadgeDataUrl returns null for count 0", () => {
  expect(buildBadgeDataUrl(0, 32)).toBeNull();
});

test("buildBadgeDataUrl returns null for negative count", () => {
  expect(buildBadgeDataUrl(-1, 32)).toBeNull();
});

test("buildBadgeDataUrl returns a data URL for positive count", () => {
  const url = buildBadgeDataUrl(3, 32);
  expect(url).toBeTypeOf("string");
  expect(url!.startsWith("data:image/svg+xml")).toBe(true);
});

test("buildBadgeDataUrl caps displayed text at 99+", () => {
  const url = buildBadgeDataUrl(100, 32)!;
  const decoded = decodeURIComponent(url);
  expect(decoded).toContain("99+");
});

test("buildBadgeDataUrl shows exact number up to 99", () => {
  const url = buildBadgeDataUrl(99, 32)!;
  const decoded = decodeURIComponent(url);
  expect(decoded).toContain(">99<");
});

test("buildBadgeDataUrl shows single digit", () => {
  const url = buildBadgeDataUrl(5, 32)!;
  const decoded = decodeURIComponent(url);
  expect(decoded).toContain(">5<");
});
