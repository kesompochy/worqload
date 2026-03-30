import { test, expect } from "bun:test";
import { parseFlags } from "./args";

test("parseFlags extracts known flags", () => {
  const { flags, rest } = parseFlags(["--name", "alice", "pos"], ["--name"]);
  expect(flags).toEqual({ "--name": "alice" });
  expect(rest).toEqual(["pos"]);
});

test("parseFlags returns all args as rest when no flags match", () => {
  const { flags, rest } = parseFlags(["a", "b", "c"], ["--x"]);
  expect(flags).toEqual({});
  expect(rest).toEqual(["a", "b", "c"]);
});

test("parseFlags handles multiple flags", () => {
  const { flags, rest } = parseFlags(
    ["--human", "question?", "--priority", "5", "title"],
    ["--human", "--priority"],
  );
  expect(flags).toEqual({ "--human": "question?", "--priority": "5" });
  expect(rest).toEqual(["title"]);
});

test("parseFlags treats flag without value as positional", () => {
  const { flags, rest } = parseFlags(["--flag"], ["--flag"]);
  expect(flags).toEqual({});
  expect(rest).toEqual(["--flag"]);
});

test("parseFlags returns empty result for empty args", () => {
  const { flags, rest } = parseFlags([], ["--x"]);
  expect(flags).toEqual({});
  expect(rest).toEqual([]);
});

test("parseFlags recognizes boolean flags", () => {
  const { flags, rest } = parseFlags(["--plan", "title"], ["--priority"], ["--plan"]);
  expect(flags).toEqual({ "--plan": "true" });
  expect(rest).toEqual(["title"]);
});

test("parseFlags handles boolean and value flags together", () => {
  const { flags, rest } = parseFlags(
    ["--plan", "--priority", "5", "my", "task"],
    ["--priority"],
    ["--plan"],
  );
  expect(flags).toEqual({ "--plan": "true", "--priority": "5" });
  expect(rest).toEqual(["my", "task"]);
});

test("parseFlags boolean flag absent yields no entry", () => {
  const { flags, rest } = parseFlags(["title"], ["--priority"], ["--plan"]);
  expect(flags).toEqual({});
  expect(rest).toEqual(["title"]);
});
