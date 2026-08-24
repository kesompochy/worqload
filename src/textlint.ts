// The "推敲モード" (revise mode) config the human authors in
// `~/.config/worqload/config.yaml`. Two parts, both optional and injected into
// the server:
//   - `textlint:` — the lint gate. When a report submitted under revise mode
//     contains a forbidden string, the matching rule's comment is returned and
//     the report is bounced for re-revision. A rule fires on either of two
//     matches: a literal substring occurrence, or a morphological match where
//     the rule's word appears in the report in an inflected form (rule 「寄せる」
//     fires on 「寄せたい」/「寄せて」). The literal pass is kept because the rules
//     are hand-tuned phrasings, some not whole words; the morphological pass is
//     layered on top so conjugated verbs and adjectives are also caught without
//     the human enumerating every inflection.
//   - `reviseFeedback:` — the editorial guidance appended to the generic
//     revise-mode bounce message (see buildRevisionRequestFeedback in
//     web-server). Only the guidance is configurable; the surrounding scaffold
//     (draft path, resubmit command) is always the fixed template. Absent means
//     the bounce carries no guidance.

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IpadicFeatures, Tokenizer } from "kuromoji";
import * as kuromoji from "kuromoji";

export interface TextlintRule {
  // The literal substring that, if present unescaped in a report, bounces it.
  string: string;
  // The note returned to the session explaining why the string is rejected.
  comment: string;
}

export interface TextlintViolation {
  string: string;
  comment: string;
}

// The escape character. A rule string is exempt from the lint at any position
// where it is immediately preceded by this character: writing `\可能性` lets a
// report mention 「可能性」 (or quote a rule itself) without being bounced. The
// backslash is left in the stored report verbatim — the lint only reads it as a
// signal and never rewrites the text — so a report is free to contain `\`.
const ESCAPE_CHARACTER = "\\";

// `~/.config/worqload/config.yaml` — the single config file the human edits to
// inject rules. Resolved per call so a changed $HOME (tests) is honoured.
export function defaultConfigPath(): string {
  return join(homedir(), ".config", "worqload", "config.yaml");
}

// Reads and parses the config file. A missing file means "no rules configured",
// not an error, so revise mode works unchanged before the human writes a config.
export async function loadTextlintRules(configPath: string): Promise<TextlintRule[]> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return [];
  return parseTextlintRules(await file.text());
}

// Extracts the `textlint:` list from the config YAML. A malformed file throws so
// the misconfiguration surfaces at server startup rather than silently disabling
// the gate. An absent `textlint:` key is treated as "no rules".
export function parseTextlintRules(yamlText: string): TextlintRule[] {
  const parsed = Bun.YAML.parse(yamlText) as unknown;
  if (parsed == null) return [];
  if (typeof parsed !== "object") {
    throw new Error("textlint config: top level must be a YAML mapping");
  }
  const raw = (parsed as Record<string, unknown>).textlint;
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("textlint config: `textlint` must be a list of { string, comment } entries");
  }
  return raw.map((entry, index) => {
    if (entry == null || typeof entry !== "object") {
      throw new Error(`textlint config: entry ${index} must be a mapping with string and comment`);
    }
    const { string: matchString, comment } = entry as Record<string, unknown>;
    if (typeof matchString !== "string" || matchString === "") {
      throw new Error(`textlint config: entry ${index} is missing a non-empty string`);
    }
    if (typeof comment !== "string" || comment === "") {
      throw new Error(`textlint config: entry ${index} is missing a non-empty comment`);
    }
    return { string: matchString, comment };
  });
}

// Reads the optional `reviseFeedback:` guidance override. A missing file or
// absent key means "use the built-in default guidance", returned as null so the
// caller falls back.
export async function loadReviseFeedbackGuidance(configPath: string): Promise<string | null> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return null;
  return parseReviseFeedbackGuidance(await file.text());
}

// Extracts the `reviseFeedback:` guidance string from the config YAML. An absent
// key returns null; a present-but-non-string (or empty) value throws so the
// misconfiguration surfaces rather than silently keeping the default. The
// returned guidance is substituted into the fixed bounce scaffold by the caller.
export function parseReviseFeedbackGuidance(yamlText: string): string | null {
  const parsed = Bun.YAML.parse(yamlText) as unknown;
  if (parsed == null) return null;
  if (typeof parsed !== "object") {
    throw new Error("config: top level must be a YAML mapping");
  }
  const raw = (parsed as Record<string, unknown>).reviseFeedback;
  if (raw == null) return null;
  if (typeof raw !== "string" || raw === "") {
    throw new Error("config: `reviseFeedback` must be a non-empty string");
  }
  return raw;
}

// Builds the morphological tokenizer, memoized so the IPADIC dictionary (loaded
// once into memory, ~100ms) is shared across every caller in the process rather
// than rebuilt per server start or per report. The dictionary ships inside the
// kuromoji package; resolve its `dict/` directory relative to the package's
// entry point so it is found wherever the package is installed.
let sharedTokenizer: Promise<Tokenizer<IpadicFeatures>> | null = null;
export function getTextlintTokenizer(): Promise<Tokenizer<IpadicFeatures>> {
  if (sharedTokenizer === null) {
    const dicPath = join(dirname(createRequire(import.meta.url).resolve("kuromoji")), "..", "dict");
    sharedTokenizer = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath }).build((err, tokenizer) => {
        if (err) reject(err);
        else resolve(tokenizer);
      });
    });
  }
  return sharedTokenizer;
}

export async function loadProtocolPrefix(configPath: string): Promise<string | null> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return null;
  return parseProtocolPrefix(await file.text());
}

export function parseProtocolPrefix(yamlText: string): string | null {
  const parsed = Bun.YAML.parse(yamlText) as unknown;
  if (parsed == null) return null;
  if (typeof parsed !== "object") {
    throw new Error("config: top level must be a YAML mapping");
  }
  const raw = (parsed as Record<string, unknown>).protocolPrefix;
  if (raw == null) return null;
  if (typeof raw !== "string" || raw === "") {
    throw new Error("config: `protocolPrefix` must be a non-empty string");
  }
  return raw;
}

// Returns one violation per rule that the report trips. A rule fires when its
// string occurs as an unescaped literal substring, or — when a tokenizer is
// supplied — when its word appears in the report in an inflected form. Without
// a tokenizer only the literal pass runs, so the gate still works (literal-only)
// when the dictionary failed to load.
export function lintReport(
  text: string,
  rules: TextlintRule[],
  tokenizer?: Tokenizer<IpadicFeatures>,
): TextlintViolation[] {
  const reportTokens = tokenizer ? tokenizer.tokenize(text) : null;
  const violations: TextlintViolation[] = [];
  for (const rule of rules) {
    const literalMatch = hasUnescapedOccurrence(text, rule.string);
    const inflectedMatch =
      tokenizer !== undefined &&
      reportTokens !== null &&
      hasUnescapedInflectedMatch(text, reportTokens, rule.string, tokenizer);
    if (literalMatch || inflectedMatch) {
      violations.push({ string: rule.string, comment: rule.comment });
    }
  }
  return violations;
}

// The dictionary (base) form of a token, falling back to the surface form for
// tokens kuromoji has no base form for (symbols, unknown words, marked "*").
function lemmaOf(token: IpadicFeatures): string {
  return token.basic_form !== "*" ? token.basic_form : token.surface_form;
}

// True when the rule's word sequence appears in the report as a run of tokens
// with matching base forms, unescaped. The rule string is tokenized to its own
// base-form sequence and matched against the report's; matching on base forms is
// what lets 「寄せる」 catch 「寄せたい」. An occurrence is exempt when the character
// directly before its first token is the escape character — the same escape the
// literal pass honours, located here via the token's 1-based `word_position`.
function hasUnescapedInflectedMatch(
  text: string,
  reportTokens: IpadicFeatures[],
  ruleString: string,
  tokenizer: Tokenizer<IpadicFeatures>,
): boolean {
  const pattern = tokenizer.tokenize(ruleString).map(lemmaOf);
  if (pattern.length === 0) return false;
  for (let start = 0; start + pattern.length <= reportTokens.length; start++) {
    let matched = true;
    for (let offset = 0; offset < pattern.length; offset++) {
      if (lemmaOf(reportTokens[start + offset]) !== pattern[offset]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const charIndex = reportTokens[start].word_position - 1;
    if (charIndex === 0 || text[charIndex - 1] !== ESCAPE_CHARACTER) return true;
  }
  return false;
}

// True when `needle` occurs in `text` at least once without an escape character
// directly in front of it. Occurrences preceded by `\` are skipped, and the
// search continues past them so an escaped occurrence never masks a later
// unescaped one.
function hasUnescapedOccurrence(text: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index === -1) return false;
    if (index === 0 || text[index - 1] !== ESCAPE_CHARACTER) return true;
    from = index + 1;
  }
}
