import { expect, test } from "bun:test";
import { interpretGhPrList } from "./pr-link";

test("interpretGhPrList returns the PR URL when gh lists one for the branch", () => {
  const stdout = JSON.stringify([{ url: "https://github.com/owner/repo/pull/42" }]);
  expect(interpretGhPrList({ spawned: true, exitCode: 0, stdout })).toEqual({
    url: "https://github.com/owner/repo/pull/42",
  });
});

test("interpretGhPrList returns no-pr when gh runs but lists nothing for the branch", () => {
  expect(interpretGhPrList({ spawned: true, exitCode: 0, stdout: "[]\n" })).toEqual({
    url: null,
    reason: "no-pr",
  });
});

test("interpretGhPrList returns gh-missing when the gh binary could not be spawned", () => {
  expect(interpretGhPrList({ spawned: false, exitCode: -1, stdout: "" })).toEqual({
    url: null,
    reason: "gh-missing",
  });
});

test("interpretGhPrList returns gh-error on a non-zero exit (not authed, no remote, …)", () => {
  expect(interpretGhPrList({ spawned: true, exitCode: 1, stdout: "" })).toEqual({
    url: null,
    reason: "gh-error",
  });
});

test("interpretGhPrList returns gh-error when gh's output is not the expected JSON", () => {
  expect(interpretGhPrList({ spawned: true, exitCode: 0, stdout: "not json" })).toEqual({
    url: null,
    reason: "gh-error",
  });
});
