// The disposable report-only agent. worqload runs this over a submitted report
// (when the session's reportAgentEnabled flag is on) before storing it, so the
// working session no longer has to 推敲 its own prose. One claude invocation
// per report, spawned from the same command sessions use — so WORQLOAD_DRIVER /
// WORQLOAD_SPAWN_COMMAND apply here too — fed a single stream-json user message,
// drained for assistant text, then gone. The agent may also judge a report not
// worth the human's time and ask that it be dropped entirely (SUPPRESS_SENTINEL),
// or judge it a misfiled request for a decision that belongs in an Escalation
// (ESCALATE_SENTINEL).

import { readLines } from "./claude-stream";
import { buildUserMessage } from "./session-bootstrap";
import type { AgentName } from "./session";
export type { AgentName };

// The agent's verdict on a submitted report:
//  - string: the rewritten report, to be stored.
//  - null: suppress — not worth the human's time, store nothing.
//  - { escalate: true }: the report is really a request for a decision; reject
//    the submission so the session resubmits it as an Escalation.
export type ReportVerdict = string | null | { escalate: true };
export type ReportRewriter = (rawReport: string, opts: { cwd: string }) => Promise<ReportVerdict>;

// The agent emits one of these strings — alone, as its entire output — to pick
// a non-rewrite verdict. Each triggers only on an exact match, so any other
// output (including one that merely contains a sentinel) is treated as a
// rewrite and kept: a garbled emission degrades to storing the report, never
// to silently dropping or rerouting it.
export const SUPPRESS_SENTINEL = "<<WORQLOAD_REPORT_SUPPRESS>>";
export const ESCALATE_SENTINEL = "<<WORQLOAD_REPORT_ESCALATE>>";

const GUIDANCE = `あなたは worqload のレポート整形係です。以下に AI セッションが書いた生のレポート（Markdown）を渡します。これを、人間が短時間で読めるレポートに書き直してください。

書き直しの原則:
- 結論を最初に置く。最初の一文で、人間が知るべきことが伝わるようにする。
- 一文を短くする。一文に詰め込まず、区切る。
- 冗長な前置き・自己弁護・謝辞・経緯の長い語りを削る。観察したこと・判断したこと・行ったことを、その順で簡潔に。
- 事実は変えない。レポートが述べていない内容を足さない。
- 言語は日本語のまま。Markdown 構造（見出し・箇条書き・コードブロック）は保つ。

レポートでなくエスカレーションにすべきものを見分ける:
- レポートは人間に進捗を伝えるものであって、人間から判断・指示・承認を引き出すためのものではない。それは Escalation の役割。レポートが人間に判断・指示・承認を求めているときは、書き直しも破棄もせず ${ESCALATE_SENTINEL} という文字列だけを出力する（前後に何も付けない）。
- エスカレーション対象: 人間に向けた疑問文。複数の選択肢を挙げて人間に選ばせるもの。承認・許可を求めるもの。「どうしますか」「これでよいか確認したい」「指示がほしい」の類。人間の応答を待つことを前提にした記述。これらが進捗の記述に混じって一箇所あるだけでも対象とする。
- エスカレーション対象ではない: セッションが次に何をするかを宣言しただけのもの（「次は X をする」）。実施済みの判断・進捗・観察・結果の報告。これらは通常どおり書き直す。
- 迷うときは ${ESCALATE_SENTINEL} を出さない。人間に判断を求めていることが明確なときに限る。

不要なレポートは止める:
- レポート全体が、人間が読んで得るもののない内容のときは、書き直さず破棄する。破棄するときは ${SUPPRESS_SENTINEL} という文字列だけを出力する（前後に何も付けない）。
- 破棄の対象: 全体が自己弁護・謝辞・言い訳であるもの。プロトコルや段取りを再説明しただけのもの。すでに報告済みの判断を蒸し返すだけで、新しい観察・判断・行動を含まないもの。人間が次に何を知る・何を行うかを一切変えないもの。
- 人間の feedback への応答であることは、それ自体ではレポートを必要にしない。意味のない暴言やノイズへの応答レポートも、新しい中身が無ければ破棄する。
- 迷うときは破棄しない。新しい事実・判断・行動が一つでも含まれるなら、書き直して残す。一部に不要な記述が混じるだけなら、その部分を削って残す。破棄はレポート全体が不要なときに限る。

出力は次のいずれか一つだけ。書き直したレポートの Markdown 本文のみ / エスカレーションにすべきなら ${ESCALATE_SENTINEL} のみ / 破棄するなら ${SUPPRESS_SENTINEL} のみ。前置き・後書き・説明・コードフェンスでの全体の囲みは付けない。ツールは使わない。`;

// The prompt handed to the disposable agent: the guidance, then the raw report
// fenced off by a marker so the agent can tell instruction from payload.
export function buildReportRewritePrompt(rawReport: string): string {
  return `${GUIDANCE}\n\n--- 生のレポートここから ---\n\n${rawReport}\n\n--- 生のレポートここまで ---`;
}

export interface ClaudeReportRewriterOptions {
  // The same argv worqload spawns sessions with (ctx.spawnCommand). Reusing it
  // is what makes the driver env vars apply to the disposable agent.
  spawnCommand: string[];
  // Hard ceiling so a wedged agent can't block report submission forever.
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

// Env for the disposable agent: the parent's, minus the worqload session
// identity. Without those vars the agent can't reach serve's /internal routes,
// so it can't impersonate the session (submit reports, fetch feedback) — it
// only transforms the text we hand it on stdin.
function rewriterEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (k === "WORQLOAD_SESSION_ID" || k === "WORQLOAD_ENDPOINT" || k === "WORQLOAD_ENDPOINT_FILE") continue;
    env[k] = v;
  }
  return env;
}

function extractAssistantText(line: string, sink: string[]): void {
  let parsed: { type?: string; message?: { content?: unknown } };
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (parsed?.type !== "assistant") return;
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === "text" && typeof b.text === "string") sink.push(b.text);
  }
}

// Final-output normalisation shared by both rewriters: a clean run with empty
// (or whitespace-only) text falls back to the raw report so we never lose it;
// the bare sentinel triggers the suppress / escalate verdicts; anything else
// is treated as the rewritten body.
function interpretRewrittenOutput(rewritten: string, rawReport: string): ReportVerdict {
  const trimmed = rewritten.trim();
  if (trimmed === "") return rawReport;
  if (trimmed === SUPPRESS_SENTINEL) return null;
  if (trimmed === ESCALATE_SENTINEL) return { escalate: true };
  return trimmed;
}

export function makeClaudeReportRewriter(opts: ClaudeReportRewriterOptions): ReportRewriter {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (rawReport, { cwd }) => {
    try {
      const proc = Bun.spawn(opts.spawnCommand, {
        cwd,
        env: rewriterEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const texts: string[] = [];
      const stdoutTask = readLines(proc.stdout, (line) => extractAssistantText(line, texts));
      // Drain stderr so a chatty agent can't fill the pipe buffer and wedge.
      const stderrTask = readLines(proc.stderr, () => {});

      const message = `${JSON.stringify(buildUserMessage(buildReportRewritePrompt(rawReport)))}\n`;
      try {
        proc.stdin.write(message);
        await proc.stdin.flush();
        proc.stdin.end();
      } catch {
        // Agent already gone (e.g. crashed before reading stdin); the exit-code
        // check below turns this into the raw-report fallback.
      }

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, timeoutMs);
      const code = await proc.exited;
      clearTimeout(timer);
      await Promise.allSettled([stdoutTask, stderrTask]);

      if (timedOut || code !== 0) return rawReport;
      return interpretRewrittenOutput(texts.join(""), rawReport);
    } catch {
      // Spawn itself failed (binary not found, ...). Never lose the report.
      return rawReport;
    }
  };
}

export interface CodexReportRewriterOptions {
  // codex binary prefix (e.g. ["codex"] or ["codex", "--config", "foo"]).
  // The rewriter appends `exec --json -` so codex reads the prompt from stdin
  // and emits its JSONL event stream — same one-shot lifecycle as the codex
  // session driver's first turn.
  spawnCommand: string[];
  timeoutMs?: number;
}

// Extract the concatenated text of every `agent_message` item.completed line
// in a codex JSONL output. (item.updated also carries text, but completed is
// the terminal state — using it alone avoids double-counting.)
function extractCodexAgentMessageText(line: string, sink: string[]): void {
  let parsed: { type?: string; item?: { type?: string; text?: unknown } };
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (parsed?.type !== "item.completed") return;
  if (parsed.item?.type !== "agent_message") return;
  if (typeof parsed.item.text === "string") sink.push(parsed.item.text);
}

export function makeCodexReportRewriter(opts: CodexReportRewriterOptions): ReportRewriter {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (rawReport, { cwd }) => {
    try {
      const proc = Bun.spawn([...opts.spawnCommand, "exec", "--json", "-"], {
        cwd,
        env: rewriterEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const texts: string[] = [];
      const stdoutTask = readLines(proc.stdout, (line) => extractCodexAgentMessageText(line, texts));
      const stderrTask = readLines(proc.stderr, () => {});

      try {
        proc.stdin.write(buildReportRewritePrompt(rawReport));
        await proc.stdin.flush();
        proc.stdin.end();
      } catch {
        // Codex already gone; the exit-code check below routes us to the
        // raw-report fallback.
      }

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, timeoutMs);
      const code = await proc.exited;
      clearTimeout(timer);
      await Promise.allSettled([stdoutTask, stderrTask]);

      if (timedOut || code !== 0) return rawReport;
      return interpretRewrittenOutput(texts.join(""), rawReport);
    } catch {
      return rawReport;
    }
  };
}
