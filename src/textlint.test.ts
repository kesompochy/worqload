import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import type { IpadicFeatures, Tokenizer } from "kuromoji";
import { join } from "path";
import { makeTmpDir } from "./test-helpers";
import {
  getTextlintTokenizer,
  lintReport,
  loadReviseFeedbackGuidance,
  loadTextlintRules,
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

test("loadTextlintRules returns no rules when the config file is absent", async () => {
  const dir = makeTmpDir("textlint-config");
  expect(await loadTextlintRules(join(dir, "config.yaml"))).toEqual([]);
});

test("loadTextlintRules reads rules from the config file on disk", async () => {
  const dir = makeTmpDir("textlint-config");
  const configPath = join(dir, ".config", "worqload", "config.yaml");
  mkdirSync(join(dir, ".config", "worqload"), { recursive: true });
  writeFileSync(configPath, 'textlint:\n  - string: "禁止語"\n    comment: "使わない"\n');
  expect(await loadTextlintRules(configPath)).toEqual([{ string: "禁止語", comment: "使わない" }]);
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

test("loadReviseFeedbackGuidance returns null when the config file is absent", async () => {
  const dir = makeTmpDir("revise-feedback-config");
  expect(await loadReviseFeedbackGuidance(join(dir, "config.yaml"))).toBeNull();
});

test("loadReviseFeedbackGuidance reads the guidance from the config file on disk", async () => {
  const dir = makeTmpDir("revise-feedback-config");
  const configPath = join(dir, ".config", "worqload", "config.yaml");
  mkdirSync(join(dir, ".config", "worqload"), { recursive: true });
  writeFileSync(configPath, 'reviseFeedback: "結論から書け"\n');
  expect(await loadReviseFeedbackGuidance(configPath)).toBe("結論から書け");
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

let tokenizer: Tokenizer<IpadicFeatures>;
beforeAll(async () => {
  tokenizer = await getTextlintTokenizer();
});

const YOSERU = [{ string: "寄せる", comment: "既存実装に揃えるという意味で使わない" }];

test("lintReport with a tokenizer matches a rule against an inflected form of the same verb", () => {
  expect(lintReport("挙動を既存実装に寄せたい", YOSERU, tokenizer)).toEqual(YOSERU);
  expect(lintReport("テストも寄せて整理した", YOSERU, tokenizer)).toEqual(YOSERU);
  expect(lintReport("そこに寄せれば直る", YOSERU, tokenizer)).toEqual(YOSERU);
});

test("lintReport with a tokenizer does not match a different word that only shares a surface prefix", () => {
  // 「寄せ集め」 tokenizes as 寄せ(名詞)+集め, whose lemma is 寄せ — not the verb 寄せる.
  expect(lintReport("設定ファイルの寄せ集めだ", YOSERU, tokenizer)).toEqual([]);
});

test("lintReport with a tokenizer still flags an exact literal occurrence", () => {
  expect(lintReport("この変更には可能性がある", RULES, tokenizer)).toEqual([
    { string: "可能性", comment: "統計的事実のときだけ使う" },
  ]);
});

test("lintReport with a tokenizer exempts an inflected match escaped with a leading backslash", () => {
  expect(lintReport("\\寄せたい は引用なので許す", YOSERU, tokenizer)).toEqual([]);
});
