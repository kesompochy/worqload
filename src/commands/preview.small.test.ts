import { describe, expect, test } from "bun:test";
import { previewHostCommand, previewRepoDir } from "./preview";

describe("previewRepoDir", () => {
  test("uses WORQLOAD_PREVIEW_REPO when set", () => {
    expect(previewRepoDir({ WORQLOAD_PREVIEW_REPO: "/tmp/p", HOME: "/home/x" })).toBe("/tmp/p");
  });

  test("defaults to ~/.worqload-preview", () => {
    expect(previewRepoDir({ HOME: "/home/x" })).toBe("/home/x/.worqload-preview");
  });

  test("ignores a blank WORQLOAD_PREVIEW_REPO", () => {
    expect(previewRepoDir({ WORQLOAD_PREVIEW_REPO: "   ", HOME: "/home/x" })).toBe("/home/x/.worqload-preview");
  });
});

describe("previewHostCommand", () => {
  test("points the per-session host at this checkout's cli.ts via the running runtime", () => {
    expect(previewHostCommand("/opt/bun", "/work/worqload")).toEqual([
      "/opt/bun",
      "/work/worqload/src/cli.ts",
      "session-host",
    ]);
  });
});
