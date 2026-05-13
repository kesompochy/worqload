import { test, expect, beforeEach, afterEach } from "bun:test";
import { readUrlState, syncUrlState } from "../web/url-state.js";

// Bun's runtime has no window/location; the URL-state helpers guard against
// that, but to exercise them at all we drop in a tiny fake and restore it
// after each test so other test files keep seeing the real (undefined) globals.
type FakeWindow = {
  location: { search: string; pathname: string; hash: string };
  history: { replaceState: (state: unknown, title: string, url: string) => void };
};
let savedWindow: unknown;
let lastReplacedUrl: string;

function installWindow(search: string, pathname = "/", hash = ""): FakeWindow {
  lastReplacedUrl = "";
  const fake: FakeWindow = {
    location: { search, pathname, hash },
    history: { replaceState: (_s, _t, url) => { lastReplacedUrl = url; fake.location.search = new URL(url, "http://x").search; } },
  };
  (globalThis as unknown as { window: FakeWindow }).window = fake;
  return fake;
}

beforeEach(() => {
  savedWindow = (globalThis as unknown as { window: unknown }).window;
});
afterEach(() => {
  (globalThis as unknown as { window: unknown }).window = savedWindow;
});

test("readUrlState reads session and tab from the query string", () => {
  installWindow("?session=abc&tab=diff");
  expect(readUrlState()).toEqual({ sessionId: "abc", tab: "diff" });
});

test("readUrlState ignores an unknown tab name", () => {
  installWindow("?session=abc&tab=garbage");
  expect(readUrlState()).toEqual({ sessionId: "abc", tab: null });
});

test("readUrlState returns nulls when no params are present", () => {
  installWindow("");
  expect(readUrlState()).toEqual({ sessionId: null, tab: null });
});

test("syncUrlState writes session and a non-default tab to the URL", () => {
  installWindow("");
  syncUrlState({ sessionId: "abc", tab: "diff" });
  expect(lastReplacedUrl).toBe("/?session=abc&tab=diff");
});

test("syncUrlState omits the default tab to keep URLs clean", () => {
  installWindow("");
  syncUrlState({ sessionId: "abc", tab: "reports" });
  expect(lastReplacedUrl).toBe("/?session=abc");
});

test("syncUrlState removes the session param when it goes null", () => {
  installWindow("?session=abc&tab=diff");
  syncUrlState({ sessionId: null, tab: null });
  expect(lastReplacedUrl).toBe("/");
});

test("syncUrlState preserves unrelated query params already on the URL", () => {
  installWindow("?theme=dark");
  syncUrlState({ sessionId: "abc", tab: "files" });
  // URLSearchParams keeps insertion order, so the pre-existing param stays first.
  expect(lastReplacedUrl).toBe("/?theme=dark&session=abc&tab=files");
});

test("syncUrlState is a no-op when window/history is unavailable", () => {
  (globalThis as unknown as { window: unknown }).window = undefined;
  expect(() => syncUrlState({ sessionId: "abc", tab: "diff" })).not.toThrow();
});
