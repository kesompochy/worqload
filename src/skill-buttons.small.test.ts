import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { makeTmpDir } from "./test-helpers";
import { parseSkillPaths, scanSkillDirectory, loadSkillButtons, appendSkillLoadNotices } from "./skill-buttons";

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

const reviewSkill = { name: "review", sourcePath: "/skills/review/SKILL.md" };

test("appendSkillLoadNotices keeps the human's text and names the referenced skill with its SKILL.md path", () => {
  const result = appendSkillLoadNotices("please run /review on this", [reviewSkill]);
  expect(result).toStartWith("please run /review on this\n\n");
  const notice = result.slice("please run /review on this".length);
  expect(notice).toContain("review");
  expect(notice).toContain("/skills/review/SKILL.md");
});

test("appendSkillLoadNotices adds one notice per distinct skill", () => {
  const result = appendSkillLoadNotices("/review then /review again", [reviewSkill]);
  expect(result.split("/skills/review/SKILL.md")).toHaveLength(2);
});

test("appendSkillLoadNotices leaves unregistered /names unchanged", () => {
  const content = "/unknown-skill some text";
  expect(appendSkillLoadNotices(content, [reviewSkill])).toBe(content);
});

test("appendSkillLoadNotices ignores /name inside a word", () => {
  const tmpSkill = { name: "tmp", sourcePath: "/skills/tmp/SKILL.md" };
  expect(appendSkillLoadNotices("path/tmp/foo", [tmpSkill])).toBe("path/tmp/foo");
});
