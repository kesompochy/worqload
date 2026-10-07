import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { kbLaunchOf, matchingKbBinding, parseKbBindings, wrapClaudeCommandWithKb } from "./kb";

test("parseKbBindings returns [] when the key is absent", () => {
  expect(parseKbBindings("textlint: []")).toEqual([]);
});

test("parseKbBindings returns [] for empty yaml", () => {
  expect(parseKbBindings("")).toEqual([]);
});

test("parseKbBindings parses name and the optional kb options", () => {
  const yaml = `
kb:
  - directory: /projects/app-a
    name: app-a
  - directory: /projects/app-b
    name: app-b
    file: v1.00
    store: research
    remote: true
`;
  expect(parseKbBindings(yaml)).toEqual([
    { directory: "/projects/app-a", name: "app-a" },
    { directory: "/projects/app-b", name: "app-b", file: "v1.00", store: "research", remote: true },
  ]);
});

test("parseKbBindings throws on non-array value", () => {
  expect(() => parseKbBindings("kb: notes")).toThrow("`kb` must be a list");
});

test("parseKbBindings throws on entry missing directory", () => {
  expect(() => parseKbBindings("kb:\n  - name: notes")).toThrow("missing a non-empty directory");
});

test("parseKbBindings throws on entry missing name", () => {
  expect(() => parseKbBindings("kb:\n  - directory: /foo")).toThrow("missing a non-empty name");
});

test("parseKbBindings throws on non-boolean remote", () => {
  expect(() => parseKbBindings("kb:\n  - directory: /foo\n    name: foo\n    remote: yes-please")).toThrow("remote must be a boolean");
});

test("matchingKbBinding picks the entry for the repo, expanding ~ and ignoring a trailing slash", () => {
  const bindings = [
    { directory: "/projects/other", name: "other" },
    { directory: "~/projects/app/", name: "app" },
  ];
  expect(matchingKbBinding(bindings, join(homedir(), "projects/app"))).toEqual({ directory: "~/projects/app/", name: "app" });
});

test("matchingKbBinding returns undefined when no entry matches the repo", () => {
  expect(matchingKbBinding([{ directory: "/projects/app", name: "app" }], "/projects/other")).toBeUndefined();
});

test("wrapClaudeCommandWithKb puts `kb <name> [options]` in front of the claude argv", () => {
  expect(wrapClaudeCommandWithKb(["claude", "--dangerously-skip-permissions"], { name: "app" }))
    .toEqual(["kb", "app", "claude", "--dangerously-skip-permissions"]);
  expect(wrapClaudeCommandWithKb(["claude", "-p"], { name: "app", file: "v1", store: "research", remote: true }))
    .toEqual(["kb", "app", "--file", "v1", "--store", "research", "--remote", "claude", "-p"]);
});

test("kbLaunchOf drops the repository directory and keeps the kb arguments", () => {
  expect(kbLaunchOf({ directory: "/p", name: "app", file: "v1" })).toEqual({ name: "app", file: "v1" });
});
