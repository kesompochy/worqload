import { expect, test } from "bun:test";
import { parseSessionCreateHooks, matchingCommands, type SessionCreateHook } from "./hooks";

test("parseSessionCreateHooks returns [] when the key is absent", () => {
  expect(parseSessionCreateHooks("textlint: []")).toEqual([]);
});

test("parseSessionCreateHooks returns [] for empty yaml", () => {
  expect(parseSessionCreateHooks("")).toEqual([]);
});

test("parseSessionCreateHooks parses a list of hooks", () => {
  const yaml = `
onSessionCreate:
  - directory: /projects/my-app
    commands:
      - npm install
      - npm run build
`;
  expect(parseSessionCreateHooks(yaml)).toEqual([
    { directory: "/projects/my-app", commands: ["npm install", "npm run build"] },
  ]);
});

test("parseSessionCreateHooks parses multiple hooks", () => {
  const yaml = `
onSessionCreate:
  - directory: /projects/app-a
    commands:
      - bun install
  - directory: /projects/app-b
    commands:
      - npm install
`;
  expect(parseSessionCreateHooks(yaml)).toEqual([
    { directory: "/projects/app-a", commands: ["bun install"] },
    { directory: "/projects/app-b", commands: ["npm install"] },
  ]);
});

test("parseSessionCreateHooks throws on non-array value", () => {
  expect(() => parseSessionCreateHooks("onSessionCreate: hello")).toThrow("`onSessionCreate` must be a list");
});

test("parseSessionCreateHooks throws on entry missing directory", () => {
  const yaml = "onSessionCreate:\n  - commands:\n      - echo hi";
  expect(() => parseSessionCreateHooks(yaml)).toThrow("missing a non-empty directory");
});

test("parseSessionCreateHooks throws on entry missing commands", () => {
  const yaml = "onSessionCreate:\n  - directory: /foo";
  expect(() => parseSessionCreateHooks(yaml)).toThrow("missing a non-empty commands list");
});

test("parseSessionCreateHooks throws on empty commands list", () => {
  const yaml = "onSessionCreate:\n  - directory: /foo\n    commands: []";
  expect(() => parseSessionCreateHooks(yaml)).toThrow("missing a non-empty commands list");
});

test("parseSessionCreateHooks throws on non-string command", () => {
  const yaml = "onSessionCreate:\n  - directory: /foo\n    commands:\n      - 123";
  expect(() => parseSessionCreateHooks(yaml)).toThrow("command at index 0 must be a non-empty string");
});

test("parseSessionCreateHooks throws on non-object entry", () => {
  const yaml = "onSessionCreate:\n  - just a string";
  expect(() => parseSessionCreateHooks(yaml)).toThrow("entry 0 must be a mapping");
});

test("matchingCommands returns commands for matching directory", () => {
  const hooks: SessionCreateHook[] = [
    { directory: "/projects/my-app", commands: ["npm install"] },
  ];
  expect(matchingCommands(hooks, "/projects/my-app")).toEqual(["npm install"]);
});

test("matchingCommands returns [] when no directory matches", () => {
  const hooks: SessionCreateHook[] = [
    { directory: "/projects/my-app", commands: ["npm install"] },
  ];
  expect(matchingCommands(hooks, "/projects/other-app")).toEqual([]);
});

test("matchingCommands collects commands from all matching hooks", () => {
  const hooks: SessionCreateHook[] = [
    { directory: "/projects/my-app", commands: ["npm install"] },
    { directory: "/projects/my-app", commands: ["npm run build"] },
    { directory: "/projects/other", commands: ["bun install"] },
  ];
  expect(matchingCommands(hooks, "/projects/my-app")).toEqual(["npm install", "npm run build"]);
});

test("matchingCommands does not match subdirectories", () => {
  const hooks: SessionCreateHook[] = [
    { directory: "/projects", commands: ["npm install"] },
  ];
  expect(matchingCommands(hooks, "/projects/my-app")).toEqual([]);
});

test("matchingCommands normalizes trailing slash", () => {
  const hooks: SessionCreateHook[] = [
    { directory: "/projects/my-app/", commands: ["npm install"] },
  ];
  expect(matchingCommands(hooks, "/projects/my-app")).toEqual(["npm install"]);
});
