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

const { selectSession } = await import("../web/handlers.js");
const { state } = await import("../web/state.js");

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
