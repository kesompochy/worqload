import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { makeTmpDir } from "./test-helpers";
import {
  DEFAULT_FEEDBACK_TEMPLATES,
  loadFeedbackTemplates,
  parseFeedbackTemplates,
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

test("loadFeedbackTemplates reads templates from the config file", async () => {
  const dir = makeTmpDir("feedback-templates-config");
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, 'feedbackTemplates:\n  - id: mine\n    label: "Mine"\n    text: "My text"');
  expect(await loadFeedbackTemplates(configPath)).toEqual([
    { id: "mine", label: "Mine", text: "My text" },
  ]);
});
