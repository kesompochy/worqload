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
  // 推敲 moved off the working session onto a disposable report-only agent
  // worqload spins up on receipt. The session must not be told to draft to a
  // file and read it back — that round-trip is no longer its job.
  expect(prefix).not.toContain("推敲");
  expect(prefix).not.toContain(".worqload-draft/");
});

test("protocol prefix still tells the agent how to submit a report", () => {
  const prefix = buildProtocolPrefix("main");
  // Dropping 推敲 must not drop the submit mechanic itself.
  expect(prefix).toContain("worqload report submit --slug");
});

test("protocol prefix tells the agent to lead with the conclusion to respect the human's time", () => {
  const prefix = buildProtocolPrefix("main");
  // 結論ファースト. The human reads many reports; burying the point under
  // preamble steals time they cannot get back. Name the principle explicitly
  // so the agent cannot rationalize a long lead-in.
  expect(prefix.toLowerCase()).toContain("lead with the conclusion");
});
