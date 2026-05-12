import { test, expect, mock } from "bun:test";

// selectSession reaches into the DOM (render) and the network (api); stub both
// so the per-session state reset can be asserted in isolation.
mock.module("../web/render.js", () => ({
  renderSessionList() {},
  renderDetail() {},
}));
mock.module("../web/api.js", () => ({
  api: async () => ({}),
  fetchSessions: async () => {},
  refreshDetail: async () => {},
  refreshDiff: async () => {},
  ensureFilesLoaded: async () => {},
  selectFile: async () => {},
  openWs() {},
}));

const { selectSession, extractPullRequestUrl } = await import("../web/handlers.js");
const { state } = await import("../web/state.svelte.js");

test("extractPullRequestUrl pulls the PR URL out of a create-pr run log", () => {
  const log = [
    "$ git push -u origin worqload/abc12345",
    "branch 'worqload/abc12345' set up to track 'origin/worqload/abc12345'.",
    "$ gh pr create --base main --head worqload/abc12345",
    "https://github.com/kesompochy/worqload/pull/42",
  ].join("\n");
  expect(extractPullRequestUrl(log)).toBe("https://github.com/kesompochy/worqload/pull/42");
});

test("extractPullRequestUrl returns null when the log has no PR URL", () => {
  expect(extractPullRequestUrl("$ git push -u origin foo\nEverything up-to-date")).toBeNull();
});

test("selectSession drops a line anchor left over from the previously viewed session", async () => {
  // An anchor's path is session-relative (e.g. ./.worqload-reports/<file>, a
  // path that only resolves inside that session's worktree). If it survives a
  // session switch, feedback typed for the new session goes out tagged
  // "Re: <a report the new session does not have>".
  state.selected = "session-a";
  state.anchor = { path: "./.worqload-reports/012-preview-url.md", lineStart: 3, lineEnd: 3 };

  await selectSession("session-b");

  expect(state.selected).toBe("session-b");
  expect(state.anchor).toBeNull();
});
