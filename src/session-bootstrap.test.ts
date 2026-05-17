import { expect, test } from "bun:test";
import { buildProtocolPrefix } from "./session-bootstrap";

test("protocol prefix names the session's base branch", () => {
  expect(buildProtocolPrefix("develop")).toContain("develop");
});

test("protocol prefix tells the agent to check for base-branch conflicts after committing", () => {
  const prefix = buildProtocolPrefix("main");
  expect(prefix).toContain("merge-tree");
  expect(prefix.toLowerCase()).toContain("conflict");
});

test("protocol prefix no longer burdens the session with the 推敲 ceremony", () => {
  const prefix = buildProtocolPrefix("main");
  // 推敲 moved off the working session onto a disposable report-only agent.
  // The word names the polish-and-revise burden; it must be gone so the
  // session does not re-adopt it.
  expect(prefix).not.toContain("推敲");
});

test("protocol prefix routes the report through the session-private draft dir so the raw stays out of the human's view", () => {
  const prefix = buildProtocolPrefix("main");
  // The raw, unpolished draft must not reach the human when rewriting is on.
  // The session writes it into .worqload-draft/ (which worqload never shows,
  // not even in the event stream) and pipes that file into submit — so the
  // human only ever sees the rewritten version.
  expect(prefix).toContain(".worqload-draft/");
  expect(prefix).toContain("worqload report submit --slug");
  expect(prefix.toLowerCase()).toContain("session-private");
});

test("protocol prefix tells the agent to lead with the conclusion to respect the human's time", () => {
  const prefix = buildProtocolPrefix("main");
  // 結論ファースト. The human reads many reports; burying the point under
  // preamble steals time they cannot get back. Name the principle explicitly
  // so the agent cannot rationalize a long lead-in.
  expect(prefix.toLowerCase()).toContain("lead with the conclusion");
});
