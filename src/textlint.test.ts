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
