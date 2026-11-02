// Judges a report draft the way its human reader would, from only what that
// reader has seen: the task, their own messages, and the reports shown to
// them. The polish fork carries the writer's whole conversation and so reads
// drafts from the writer's side; given only the human's view, a model
// separated the human's rejections from the rest far better (26 of 39
// rejections caught against 12 of 39 accepted reports, on sessions held out).
// The judge only names the problem; the polish fork, which knows what the
// writer found, is the one that fixes it.

import { tmpdir } from "node:os";
import instructionTemplate from "./prompts/report-judge-instruction.txt" with { type: "text" };

export const JUDGE_ACCEPT_MARK = "ACCEPT";
export const JUDGE_REJECT_MARK = "REJECT";

const DEFAULT_TIMEOUT_MS = 300_000;
// The reader judges a report by what came just before it; older history only
// lengthens the prompt.
const TIMELINE_LIMIT = 30;

export interface TimelineItem {
  kind: "human" | "report";
  text: string;
}

export interface ReportJudgeRequest {
  task: string;
  timeline: TimelineItem[];
  draft: string;
  model?: string;
}

// Resolves to why the human would reject the draft, or null when they would
// accept it or the judge gave no verdict.
export type ReportJudge = (request: ReportJudgeRequest) => Promise<string | null>;

export function buildReportJudgeInstruction(request: Omit<ReportJudgeRequest, "model">): string {
  const timeline = request.timeline.slice(-TIMELINE_LIMIT)
    .map(item => `=== ${item.kind === "human" ? "Your message" : "Report shown to you"} ===\n${item.text.trim()}`)
    .join("\n\n");
  return instructionTemplate
    .replaceAll("{{accept}}", JUDGE_ACCEPT_MARK)
    .replaceAll("{{reject}}", JUDGE_REJECT_MARK)
    .replaceAll("{{task}}", request.task)
    .replaceAll("{{timeline}}", timeline)
    .replaceAll("{{draft}}", request.draft.trim());
}

export function parseJudgeVerdict(output: string): string | null {
  const lines = output.split("\n").map(line => line.replace(/\*/g, "").trim());
  const at = lines.findLastIndex(line => line === JUDGE_ACCEPT_MARK || line === JUDGE_REJECT_MARK);
  if (at < 0 || lines[at] === JUDGE_ACCEPT_MARK) return null;
  const reason = lines.slice(0, at).reverse().find(line => line !== "");
  return reason ?? null;
}

export function makeClaudeReportJudge(opts: { timeoutMs?: number } = {}): ReportJudge {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (request) => {
    const command = ["claude", "-p", "--tools", "", ...(request.model ? ["--model", request.model] : [])];
    let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">>;
    try {
      // Outside every repository, so no project's instructions reach a judge
      // that is meant to see only what the human saw.
      proc = Bun.spawn(command, { cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    } catch {
      return null;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, timeoutMs);
    try {
      proc.stdin.write(buildReportJudgeInstruction(request));
      await proc.stdin.end();
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      return parseJudgeVerdict(output);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
