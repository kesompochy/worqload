// The "推敲モード" (revise mode) config the human authors in
// `~/.config/worqload/config.yaml`. Two parts, both optional and injected into
// the server:
//   - `textlint:` — the lint gate. Plain string matches; when a report
//     submitted under revise mode contains a forbidden string, the matching
//     rule's comment is returned and the report is bounced for re-revision.
//     Matching is deliberately literal substring matching — no regex, no
//     morphological analysis — because the rules are hand-tuned phrasings the
//     human wants to keep out of stored reports.
//   - `reviseFeedback:` — the editorial guidance appended to the generic
//     revise-mode bounce message (see buildRevisionRequestFeedback in
//     web-server). Only the guidance is configurable; the surrounding scaffold
//     (draft path, resubmit command) is always the fixed template. Absent means
//     the bounce carries no guidance.

import { homedir } from "node:os";
import { join } from "node:path";

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

// Returns one violation per rule whose string appears unescaped in the report.
export function lintReport(text: string, rules: TextlintRule[]): TextlintViolation[] {
  const violations: TextlintViolation[] = [];
  for (const rule of rules) {
    if (hasUnescapedOccurrence(text, rule.string)) {
      violations.push({ string: rule.string, comment: rule.comment });
    }
  }
  return violations;
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
