import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { makeTmpDir } from "./test-helpers";
import { parseSkillPaths, scanSkillDirectory, loadSkillButtons, readSkillContent, expandSkillReferences } from "./skill-buttons";

test("scanSkillDirectory discovers skills from <name>/SKILL.md layout", async () => {
  const dir = makeTmpDir("skills");
  mkdirSync(join(dir, "codex-review"));
  writeFileSync(join(dir, "codex-review", "SKILL.md"), [
    "---",
    "name: codex-review",
    'description: "Codexにレビューを依頼する"',
    "---",
    "# Codex Review",
  ].join("\n"));
  mkdirSync(join(dir, "simplify"));
  writeFileSync(join(dir, "simplify", "SKILL.md"), [
    "---",
    "name: simplify",
    'description: "コードを簡潔にする"',
    "---",
    "# Simplify",
  ].join("\n"));

  const skills = await scanSkillDirectory(dir);
  expect(skills).toHaveLength(2);
  const names = skills.map(s => s.name).sort();
  expect(names).toEqual(["codex-review", "simplify"]);
  const codex = skills.find(s => s.name === "codex-review")!;
  expect(codex.description).toBe("Codexにレビューを依頼する");
  expect(codex.sourcePath).toBe(join(dir, "codex-review", "SKILL.md"));
});

test("scanSkillDirectory uses the directory name when frontmatter has no name", async () => {
  const dir = makeTmpDir("skills-noname");
  mkdirSync(join(dir, "my-skill"));
  writeFileSync(join(dir, "my-skill", "SKILL.md"), "# My Skill\nSome content\n");

  const skills = await scanSkillDirectory(dir);
  expect(skills).toHaveLength(1);
  expect(skills[0].name).toBe("my-skill");
  expect(skills[0].description).toBeUndefined();
});

test("scanSkillDirectory ignores entries that are not directories with SKILL.md", async () => {
  const dir = makeTmpDir("skills-mixed");
  writeFileSync(join(dir, "stray-file.txt"), "not a skill");
  mkdirSync(join(dir, "empty-dir"));
  mkdirSync(join(dir, "valid-skill"));
  writeFileSync(join(dir, "valid-skill", "SKILL.md"), "---\nname: valid-skill\n---\n");

  const skills = await scanSkillDirectory(dir);
  expect(skills).toHaveLength(1);
  expect(skills[0].name).toBe("valid-skill");
});

test("loadSkillButtons loads from config and scans all skillPaths", async () => {
  const configDir = makeTmpDir("skill-config");
  const skillsDir = join(configDir, "skills");
  mkdirSync(skillsDir);
  mkdirSync(join(skillsDir, "review"));
  writeFileSync(join(skillsDir, "review", "SKILL.md"), '---\nname: review\ndescription: "PRレビュー"\n---\n');

  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `skillPaths:\n  - ${skillsDir}\n`);

  const buttons = await loadSkillButtons(configPath);
  expect(buttons).toHaveLength(1);
  expect(buttons[0].name).toBe("review");
  expect(buttons[0].description).toBe("PRレビュー");
});

test("loadSkillButtons expands ~ to the home directory", async () => {
  const configDir = makeTmpDir("skill-config-tilde");
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, "skillPaths:\n  - ~/nonexistent-skill-dir-for-test\n");

  const buttons = await loadSkillButtons(configPath);
  expect(buttons).toEqual([]);
});

test("loadSkillButtons deduplicates skills with the same name across directories", async () => {
  const configDir = makeTmpDir("skill-dedup");
  const dir1 = join(configDir, "user-skills");
  const dir2 = join(configDir, "repo-skills");
  mkdirSync(join(dir1, "review"), { recursive: true });
  mkdirSync(join(dir2, "review"), { recursive: true });
  writeFileSync(join(dir1, "review", "SKILL.md"), '---\nname: review\ndescription: "user scope"\n---\n');
  writeFileSync(join(dir2, "review", "SKILL.md"), '---\nname: review\ndescription: "repo scope"\n---\n');

  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `skillPaths:\n  - ${dir1}\n  - ${dir2}\n`);

  const buttons = await loadSkillButtons(configPath);
  expect(buttons).toHaveLength(1);
  expect(buttons[0].description).toBe("user scope");
});

test("readSkillContent strips frontmatter and returns the body", () => {
  const dir = makeTmpDir("skill-read");
  mkdirSync(join(dir, "review"));
  const path = join(dir, "review", "SKILL.md");
  writeFileSync(path, "---\nname: review\n---\n# Review\nDo a code review.\n");
  expect(readSkillContent(path)).toBe("# Review\nDo a code review.\n");
});

test("readSkillContent returns full content when no frontmatter", () => {
  const dir = makeTmpDir("skill-read-nofm");
  mkdirSync(join(dir, "plain"));
  const path = join(dir, "plain", "SKILL.md");
  writeFileSync(path, "# Plain\nNo frontmatter here.\n");
  expect(readSkillContent(path)).toBe("# Plain\nNo frontmatter here.\n");
});

test("readSkillContent returns null for missing file", () => {
  expect(readSkillContent("/tmp/nonexistent-skill-xyz.md")).toBeNull();
});

test("expandSkillReferences expands /skill-name at the start of content", () => {
  const dir = makeTmpDir("skill-expand");
  mkdirSync(join(dir, "review"));
  const skillPath = join(dir, "review", "SKILL.md");
  writeFileSync(skillPath, "---\nname: review\n---\nReview the code.\n");
  const skills = [{ name: "review", sourcePath: skillPath }];
  const result = expandSkillReferences("/review", skills);
  expect(result).toContain("Review the code.");
  expect(result).not.toContain("/review\n");
});

test("expandSkillReferences expands /skill-name in the middle of content", () => {
  const dir = makeTmpDir("skill-expand-mid");
  mkdirSync(join(dir, "review"));
  const skillPath = join(dir, "review", "SKILL.md");
  writeFileSync(skillPath, "---\nname: review\n---\nReview the code.\n");
  const skills = [{ name: "review", sourcePath: skillPath }];
  const result = expandSkillReferences("please run /review on this", skills);
  expect(result).toContain('<skill name="review">');
  expect(result).toStartWith("please run ");
  expect(result).toEndWith(" on this");
});

test("expandSkillReferences leaves unregistered /names unchanged", () => {
  const content = "/unknown-skill some text";
  expect(expandSkillReferences(content, [])).toBe(content);
});

test("expandSkillReferences does not expand /name inside a word", () => {
  const dir = makeTmpDir("skill-expand-noword");
  mkdirSync(join(dir, "tmp"));
  const skillPath = join(dir, "tmp", "SKILL.md");
  writeFileSync(skillPath, "---\nname: tmp\n---\nBody.\n");
  const skills = [{ name: "tmp", sourcePath: skillPath }];
  const result = expandSkillReferences("path/tmp/foo", skills);
  expect(result).toBe("path/tmp/foo");
});
