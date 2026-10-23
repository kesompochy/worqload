import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { makeTmpDir } from "./test-helpers";
import {
  DEFAULT_FEEDBACK_TEMPLATES,
  loadFeedbackTemplates,
  mergeFeedbackTemplates,
  parseFeedbackTemplates,
  stripLegacyPrefix,
} from "./feedback-templates";

test("parseFeedbackTemplates returns null when the key is absent", () => {
  expect(parseFeedbackTemplates("textlint: []")).toBeNull();
});

test("parseFeedbackTemplates parses a list of templates", () => {
  const yaml = `
feedbackTemplates:
  - id: custom
    label: "Custom label"
    text: "Custom text"
`;
  expect(parseFeedbackTemplates(yaml)).toEqual([
    { id: "custom", label: "Custom label", text: "Custom text" },
  ]);
});

test("parseFeedbackTemplates throws on non-array value", () => {
  expect(() => parseFeedbackTemplates("feedbackTemplates: hello")).toThrow("`feedbackTemplates` must be a list");
});

test("parseFeedbackTemplates throws on entry missing id", () => {
  const yaml = 'feedbackTemplates:\n  - label: "x"\n    text: "y"';
  expect(() => parseFeedbackTemplates(yaml)).toThrow("missing a non-empty id");
});

test("parseFeedbackTemplates throws on entry missing label", () => {
  const yaml = 'feedbackTemplates:\n  - id: "x"\n    text: "y"';
  expect(() => parseFeedbackTemplates(yaml)).toThrow("missing a non-empty label");
});

test("parseFeedbackTemplates throws on entry missing text", () => {
  const yaml = 'feedbackTemplates:\n  - id: "x"\n    label: "y"';
  expect(() => parseFeedbackTemplates(yaml)).toThrow("missing a non-empty text");
});

test("loadFeedbackTemplates returns defaults when the config file is absent", async () => {
  const dir = makeTmpDir("feedback-templates-config");
  expect(await loadFeedbackTemplates(join(dir, "config.yaml"))).toEqual(DEFAULT_FEEDBACK_TEMPLATES);
});

test("loadFeedbackTemplates returns defaults when the key is absent from the file", async () => {
  const dir = makeTmpDir("feedback-templates-config");
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, "textlint: []");
  expect(await loadFeedbackTemplates(configPath)).toEqual(DEFAULT_FEEDBACK_TEMPLATES);
});

test("loadFeedbackTemplates merges config templates with defaults", async () => {
  const dir = makeTmpDir("feedback-templates-config");
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, 'feedbackTemplates:\n  - id: mine\n    label: "Mine"\n    text: "My text"');
  const result = await loadFeedbackTemplates(configPath);
  expect(result).toEqual([...DEFAULT_FEEDBACK_TEMPLATES, { id: "mine", label: "Mine", text: "My text" }]);
});

test("loadFeedbackTemplates config entry with same id overrides default", async () => {
  const dir = makeTmpDir("feedback-templates-config");
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, `feedbackTemplates:\n  - id: no-edit\n    label: "Custom"\n    text: "Overridden"`);
  const result = await loadFeedbackTemplates(configPath);
  const noEdit = result.find(t => t.id === "no-edit");
  expect(noEdit).toEqual({ id: "no-edit", label: "Custom", text: "Overridden" });
  expect(result.length).toBe(DEFAULT_FEEDBACK_TEMPLATES.length);
});

test("stripLegacyPrefix removes the English prefix", () => {
  expect(stripLegacyPrefix(
    "This text was inserted by worqload on behalf of the user. The user expects the following behaviour:\nDo not push.",
  )).toBe("Do not push.");
});

test("stripLegacyPrefix removes the Japanese prefix", () => {
  expect(stripLegacyPrefix(
    "このテキストはworqloadがユーザーに代わって挿入した。ユーザーは以下の振る舞いを期待している: レポートを推敲せよ。",
  )).toBe("レポートを推敲せよ。");
});

test("stripLegacyPrefix returns text unchanged when no prefix matches", () => {
  expect(stripLegacyPrefix("Custom instruction")).toBe("Custom instruction");
});

test("parseFeedbackTemplates strips legacy prefix from text", () => {
  const yaml = `
feedbackTemplates:
  - id: custom
    label: "Custom"
    text: "This text was inserted by worqload on behalf of the user. The user expects the following behaviour:\\nDo the thing."
`;
  const result = parseFeedbackTemplates(yaml);
  expect(result![0].text).toBe("Do the thing.");
});

test("mergeFeedbackTemplates appends new and overrides matching ids", () => {
  const defaults = [{ id: "a", label: "A", text: "a" }];
  const overrides = [
    { id: "a", label: "A2", text: "a2" },
    { id: "b", label: "B", text: "b" },
  ];
  expect(mergeFeedbackTemplates(defaults, overrides)).toEqual([
    { id: "a", label: "A2", text: "a2" },
    { id: "b", label: "B", text: "b" },
  ]);
});
