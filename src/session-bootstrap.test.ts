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

test("protocol prefix defines the revision step as drafting to .worqload-draft/ and reading it back", () => {
  const prefix = buildProtocolPrefix("main");
  // The directory the agent must use as scratch space for drafts.
  expect(prefix).toContain(".worqload-draft/");
  // The act must be named — vague "deliberate and revise" was the wording the
  // agent shipped half-baked reports under. The Japanese-speaking human reviews
  // reports and asked us to call the step "推敲" explicitly.
  expect(prefix).toContain("推敲");
  // Spell out the two operations that constitute 推敲 so the agent can't gloss
  // over them: write the draft to a file, then read it back before submitting.
  expect(prefix.toLowerCase()).toContain("write");
  expect(prefix.toLowerCase()).toContain("read");
});

test("protocol prefix tells the agent to lead with the conclusion to respect the human's time", () => {
  const prefix = buildProtocolPrefix("main");
  // 結論ファースト. The human reads many reports; burying the point under
  // preamble steals time they cannot get back. Name the principle explicitly
  // so the agent cannot rationalize a long lead-in.
  expect(prefix.toLowerCase()).toContain("lead with the conclusion");
});

test("protocol prefix forbids pairing a Report with an Escalation about the same moment", () => {
  const prefix = buildProtocolPrefix("main");
  // The Report-trigger list ("rising uncertainty", "before long tool calls")
  // fires at the exact instant an Escalation fires, and "status -> Report,
  // question -> Escalation" makes the agent split one blocked moment into two
  // artifacts. The human asked that an escalation-only moment stay
  // escalation-only, so the prompt must (a) tell the agent the Escalation is
  // itself a visible timeline entry — not a silent turn — and (b) forbid a
  // paired Report about the same blocked moment outright.
  expect(prefix.toLowerCase()).toContain("timeline entry the human sees");
  expect(prefix.toLowerCase()).toContain("escalation-only means escalation-only");
});
