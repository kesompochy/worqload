import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { makeTmpDir } from "./test-helpers";
import { parseSkillPaths, scanSkillDirectory, loadSkillButtons } from "./skill-buttons";

test("parseSkillPaths reads a list of directory paths from the config YAML", () => {
  const paths = parseSkillPaths("skillPaths:\n  - ~/.claude/skills\n  - .claude/skills\n");
  expect(paths).toEqual(["~/.claude/skills", ".claude/skills"]);
});

test("parseSkillPaths returns an empty list when the key is absent", () => {
  expect(parseSkillPaths("textlint: []\n")).toEqual([]);
  expect(parseSkillPaths("")).toEqual([]);
});

test("parseSkillPaths throws on a non-list value", () => {
  expect(() => parseSkillPaths("skillPaths: not-a-list\n")).toThrow();
});

test("parseSkillPaths throws when an entry is not a string", () => {
  expect(() => parseSkillPaths("skillPaths:\n  - 123\n")).toThrow();
});

test("scanSkillDirectory returns an empty list for a nonexistent directory", async () => {
  expect(await scanSkillDirectory("/tmp/nonexistent-skills-dir-xyz")).toEqual([]);
});

test("loadSkillButtons returns an empty list when config is absent", async () => {
  expect(await loadSkillButtons("/tmp/nonexistent-config-xyz.yaml")).toEqual([]);
});

