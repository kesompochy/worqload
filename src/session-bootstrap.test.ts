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
