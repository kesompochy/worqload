// The disposable report-only agent. worqload runs this over a submitted report
// (when the session's reportAgentEnabled flag is on) before storing it, so the
// working session no longer has to 推敲 its own prose. One claude invocation
// per report, spawned from the same command sessions use — so WORQLOAD_DRIVER /
// WORQLOAD_SPAWN_COMMAND apply here too — fed a single stream-json user message,
// drained for assistant text, then gone.

import { readLines } from "./claude-stream";
import { buildUserMessage } from "./session-bootstrap";

export type ReportRewriter = (rawReport: string, opts: { cwd: string }) => Promise<string>;

const GUIDANCE = `あなたは worqload のレポート整形係です。以下に AI セッションが書いた生のレポート（Markdown）を渡します。これを、人間が短時間で読めるレポートに書き直してください。

書き直しの原則:
- 結論を最初に置く。最初の一文で、人間が知るべきことが伝わるようにする。
- 一文を短くする。一文に詰め込まず、区切る。
- 冗長な前置き・自己弁護・謝辞・経緯の長い語りを削る。観察したこと・判断したこと・行ったことを、その順で簡潔に。
- 事実は変えない。レポートが述べていない内容を足さない。
- 言語は日本語のまま。Markdown 構造（見出し・箇条書き・コードブロック）は保つ。

出力は書き直したレポートの Markdown 本文のみ。前置き・後書き・説明・コードフェンスでの全体の囲みは付けない。ツールは使わない。`;

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
      const stdoutTask = readLines(proc.stdout, line => extractAssistantText(line, texts));
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

      const rewritten = texts.join("").trim();
      if (timedOut || code !== 0 || rewritten === "") return rawReport;
      return rewritten;
    } catch {
      // Spawn itself failed (binary not found, ...). Never lose the report.
      return rawReport;
    }
  };
}
