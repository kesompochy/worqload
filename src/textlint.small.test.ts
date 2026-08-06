import { expect, test } from "bun:test";
import type { IpadicFeatures, Tokenizer } from "kuromoji";
import {
  lintReport,
  parseReviseFeedbackGuidance,
  parseTextlintRules,
} from "./textlint";

test("parseTextlintRules reads { string, comment } entries from the textlint list", () => {
  const rules = parseTextlintRules(
    [
      "textlint:",
      '  - string: "可能性"',
      '    comment: "統計的事実のときだけ使う"',
      '  - string: "強い"',
      '    comment: "曖昧な効果表現は避ける"',
    ].join("\n"),
  );
  expect(rules).toEqual([
    { string: "可能性", comment: "統計的事実のときだけ使う" },
    { string: "強い", comment: "曖昧な効果表現は避ける" },
  ]);
});

test("parseTextlintRules treats an absent textlint key as no rules", () => {
  expect(parseTextlintRules("other: 1\n")).toEqual([]);
  expect(parseTextlintRules("")).toEqual([]);
});

test("parseTextlintRules throws on a malformed entry", () => {
  expect(() => parseTextlintRules("textlint:\n  - comment: no string\n")).toThrow();
  expect(() => parseTextlintRules("textlint: not-a-list\n")).toThrow();
});

test("parseReviseFeedbackGuidance returns the reviseFeedback guidance string verbatim", () => {
  expect(parseReviseFeedbackGuidance('reviseFeedback: "結論から書け。短く。"')).toBe("結論から書け。短く。");
});

test("parseReviseFeedbackGuidance returns null when the key is absent", () => {
  expect(parseReviseFeedbackGuidance("textlint: []\n")).toBeNull();
  expect(parseReviseFeedbackGuidance("")).toBeNull();
});

test("parseReviseFeedbackGuidance throws on a non-string or empty value", () => {
  expect(() => parseReviseFeedbackGuidance("reviseFeedback: []\n")).toThrow();
  expect(() => parseReviseFeedbackGuidance('reviseFeedback: ""\n')).toThrow();
});


const RULES = [
  { string: "可能性", comment: "統計的事実のときだけ使う" },
  { string: "強い", comment: "曖昧な効果表現は避ける" },
];

test("lintReport flags each rule whose string appears in the text", () => {
  expect(lintReport("この変更には可能性がある", RULES)).toEqual([
    { string: "可能性", comment: "統計的事実のときだけ使う" },
  ]);
  expect(lintReport("可能性が強い", RULES)).toEqual(RULES);
  expect(lintReport("問題ない文章", RULES)).toEqual([]);
});

test("lintReport exempts an occurrence escaped with a leading backslash", () => {
  expect(lintReport("\\可能性 は統計用語として許容する", RULES)).toEqual([]);
});

test("lintReport still flags an unescaped occurrence elsewhere in the text", () => {
  expect(lintReport("可能性 と \\可能性 が混在する", RULES)).toEqual([
    { string: "可能性", comment: "統計的事実のときだけ使う" },
  ]);
});

