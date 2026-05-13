import { test, expect, beforeEach, afterEach } from "bun:test";
import { readUrlState, replaceUrlState, pushUrlState } from "../web/url-state.js";

// Bun's runtime has no window/location; the URL-state helpers guard against
// that, but to exercise them at all we drop in a tiny fake and restore it
// after each test so other test files keep seeing the real (undefined) globals.
type FakeWindow = {
  location: { search: string; pathname: string; hash: string };
  history: {
    replaceState: (state: unknown, title: string, url: string) => void;
    pushState: (state: unknown, title: string, url: string) => void;
  };
};
let savedWindow: unknown;
let lastReplacedUrl: string;
let lastPushedUrl: string;
let pushCount: number;

function installWindow(search: string, pathname = "/", hash = ""): FakeWindow {
  lastReplacedUrl = "";
  lastPushedUrl = "";
  pushCount = 0;
  const fake: FakeWindow = {
    location: { search, pathname, hash },
    history: {
      replaceState: (_s, _t, url) => { lastReplacedUrl = url; fake.location.search = new URL(url, "http://x").search; },
      pushState: (_s, _t, url) => { lastPushedUrl = url; pushCount++; fake.location.search = new URL(url, "http://x").search; },
    },
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

test("readUrlState reads session, tab, and focus stack from the query string", () => {
  installWindow("?session=abc&tab=diff&focus=src%2Fa.ts&focus=src%2Fb.ts");
  expect(readUrlState()).toEqual({ sessionId: "abc", tab: "diff", focusStack: ["src/a.ts", "src/b.ts"] });
});

test("readUrlState ignores an unknown tab name", () => {
  installWindow("?session=abc&tab=garbage");
  expect(readUrlState()).toEqual({ sessionId: "abc", tab: null, focusStack: [] });
});

test("readUrlState returns empty values when no params are present", () => {
  installWindow("");
  expect(readUrlState()).toEqual({ sessionId: null, tab: null, focusStack: [] });
});

test("replaceUrlState writes session and a non-default tab to the URL", () => {
  installWindow("");
  replaceUrlState({ sessionId: "abc", tab: "diff", focusStack: [] });
  expect(lastReplacedUrl).toBe("/?session=abc&tab=diff");
});

test("replaceUrlState omits the default tab to keep URLs clean", () => {
  installWindow("");
  replaceUrlState({ sessionId: "abc", tab: "reports", focusStack: [] });
  expect(lastReplacedUrl).toBe("/?session=abc");
});

test("replaceUrlState removes the session param when it goes null", () => {
  installWindow("?session=abc&tab=diff");
  replaceUrlState({ sessionId: null, tab: null, focusStack: [] });
  expect(lastReplacedUrl).toBe("/");
});

test("replaceUrlState preserves unrelated query params already on the URL", () => {
  installWindow("?theme=dark");
  replaceUrlState({ sessionId: "abc", tab: "files", focusStack: [] });
  expect(lastReplacedUrl).toBe("/?theme=dark&session=abc&tab=files");
});

test("replaceUrlState appends one `focus` query param per stack level, bottom first", () => {
  installWindow("?session=abc&tab=structure");
  replaceUrlState({ sessionId: "abc", tab: "structure", focusStack: ["src/a.ts", "src/b.ts"] });
  expect(lastReplacedUrl).toBe("/?session=abc&tab=structure&focus=src%2Fa.ts&focus=src%2Fb.ts");
});

test("replaceUrlState clears stale focus params when the stack is now empty", () => {
  installWindow("?session=abc&tab=structure&focus=src%2Fa.ts");
  replaceUrlState({ sessionId: "abc", tab: "structure", focusStack: [] });
  expect(lastReplacedUrl).toBe("/?session=abc&tab=structure");
});

test("pushUrlState creates a new history entry when the URL changed", () => {
  installWindow("?session=abc");
  pushUrlState({ sessionId: "abc", tab: "structure", focusStack: ["src/a.ts"] });
  expect(lastPushedUrl).toBe("/?session=abc&tab=structure&focus=src%2Fa.ts");
  expect(pushCount).toBe(1);
});

test("pushUrlState collapses to replaceState when the URL is unchanged", () => {
  installWindow("?session=abc");
  pushUrlState({ sessionId: "abc", tab: "reports", focusStack: [] });
  expect(pushCount).toBe(0);
  expect(lastReplacedUrl).toBe("/?session=abc");
});

test("replaceUrlState is a no-op when window/history is unavailable", () => {
  (globalThis as unknown as { window: unknown }).window = undefined;
  expect(() => replaceUrlState({ sessionId: "abc", tab: "diff", focusStack: [] })).not.toThrow();
});
