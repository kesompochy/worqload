// Polishes a submitted report in a fork of the writer's own claude
// conversation before it is stored. The fork holds everything the writer was
// told about how to write reports and everything it investigated, so it can
// rewrite against those norms without the meaning drift of a context-blind
// rewriter, and without the rewrite rounds landing in the writer's context.

import { isClaudePipeTurnEnd, readLines } from "./claude-stream";
import { buildUserMessage } from "./session-bootstrap";
import instructionTemplate from "./prompts/report-polish-instruction.txt" with { type: "text" };
import returnStepTemplate from "./prompts/report-polish-return-step.txt" with { type: "text" };
import continueStepTemplate from "./prompts/report-polish-continue-step.txt" with { type: "text" };
import escalationInstructionTemplate from "./prompts/escalation-polish-instruction.txt" with { type: "text" };
import escalationReturnStepTemplate from "./prompts/escalation-polish-return-step.txt" with { type: "text" };
import commandInstructionTemplate from "./prompts/command-approval-polish-instruction.txt" with { type: "text" };
import commandReturnStepTemplate from "./prompts/command-approval-polish-return-step.txt" with { type: "text" };
import goalTemplate from "./prompts/polish-goal.txt" with { type: "text" };
import judgeTemplate from "./prompts/polish-judge.txt" with { type: "text" };
import returnStepFrame from "./prompts/polish-return-step.txt" with { type: "text" };
import finishStepTemplate from "./prompts/polish-finish-step.txt" with { type: "text" };

// Set in the environment of a report-polish fork. The fork carries the
// writer's whole conversation, protocol instructions included, so the CLI
// refuses `report submit` under this mark to keep a polish from recursing.
export const REPORT_POLISH_FORK_ENV = "WORQLOAD_REPORT_POLISH_FORK";

// One edit block names a span of the draft, copied verbatim, and what
// replaces it. The fork edits instead of writing the text out again so the
// sentences it leaves alone reach the human exactly as the writer wrote them:
// every regenerated sentence is another chance of a flaw.
export const POLISH_EDIT_BEGIN = "<<<WORQLOAD_EDIT";
export const POLISH_EDIT_SEPARATOR = "===";
export const POLISH_EDIT_END = "WORQLOAD_EDIT>>>";
export const NO_VIOLATION_MARK = "<<WORQLOAD_NO_VIOLATION>>";
// Starts the line on which the fork withdraws the report; the rest of the
// line is its reason.
export const REPORT_WITHDRAW_MARK = "<<WORQLOAD_WITHDRAW_REPORT>>";
// Starts the line on which the fork returns the report to the writer for more
// investigation; the rest of the line is what the fork found missing.
export const REPORT_RETURN_MARK = "<<WORQLOAD_RETURN_REPORT>>";
// Starts the line, after a report's block, on which the fork judges that the
// writer should keep working instead of ending its turn; the rest of the line
// is what is left. The report is still stored for the human.
export const WRITER_CONTINUE_MARK = "<<WORQLOAD_CONTINUE_WRITER>>";

const DEFAULT_TIMEOUT_MS = 300_000;

// Escalations and command approval requests pass through the same fork as
// reports, but are never withdrawn: their writer waits for an answer that a
// silently dropped request never gets. The fork returns them to the writer
// instead. A command approval's draft is its reason; the command itself runs
// as approved, so the fork only sees it.
export type PolishedKind = "report" | "escalation" | "command";

export interface ReportPolishRequest {
  // argv that resumes the writer's conversation as a fork
  // (`... --resume <id> --fork-session`), with the writer's model.
  spawnCommand: string[];
  cwd: string;
  draft: string;
  kind: PolishedKind;
  // The command a `command` draft asks approval for.
  command?: string;
  // False for a draft resubmitted after a return, so a writer and its fork
  // cannot bounce the same report back and forth.
  allowReturn: boolean;
}

// `report` is the text to store: the fork's last well-formed rewrite, or the
// draft itself when the fork failed before producing one. `withdrawnReason`
// means the fork judged the report not worth the human's reading;
// `returnedReason` means its claims do not follow from what the conversation
// established, and the writer has to investigate before submitting again.
// `continueReason` wakes the writer of a stored report with what it left
// undone.
export type PolishOutcome = { report: string; continueReason?: string } | { withdrawnReason: string } | { returnedReason: string };
// `rounds` is the fork's output of each round, kept for the archive.
export type PolishResult = PolishOutcome & { rounds?: string[] };
export type ReportPolisher = (request: ReportPolishRequest) => Promise<PolishResult>;

const INSTRUCTION_TEMPLATES: Record<PolishedKind, [instruction: string, returnCondition: string]> = {
  report: [instructionTemplate, returnStepTemplate],
  escalation: [escalationInstructionTemplate, escalationReturnStepTemplate],
  command: [commandInstructionTemplate, commandReturnStepTemplate],
};

export function buildReportPolishInstruction(draft: string, opts: { allowReturn: boolean; kind: PolishedKind; command?: string }): string {
  const [template, returnCondition] = INSTRUCTION_TEMPLATES[opts.kind];
  const returnStep = returnStepFrame.replaceAll("{{returnCondition}}", returnCondition.trim()).replaceAll("{{return}}", REPORT_RETURN_MARK);
  return template
    .replaceAll("{{goal}}", goalTemplate.trim())
    .replaceAll("{{judge}}", judgeTemplate.trim())
    .replaceAll("{{finishStep}}", finishStepTemplate.trim())
    .replaceAll("{{command}}", opts.command ?? "")
    .replaceAll("{{returnStep}}", opts.allowReturn ? returnStep : "")
    .replaceAll("{{continueStep}}", opts.kind === "report" ? continueStepTemplate.replaceAll("{{continue}}", WRITER_CONTINUE_MARK) : "")
    .replaceAll("{{noViolation}}", NO_VIOLATION_MARK)
    .replaceAll("{{withdraw}}", REPORT_WITHDRAW_MARK)
    .replaceAll("{{begin}}", POLISH_EDIT_BEGIN)
    .replaceAll("{{separator}}", POLISH_EDIT_SEPARATOR)
    .replaceAll("{{end}}", POLISH_EDIT_END)
    .replaceAll("{{draft}}", draft);
}

type PolishRound = { report: string; continueReason?: string } | { withdrawnReason: string } | { returnedReason: string };

type PolishEdit = { from: string; to: string };

function parseEdits(output: string): PolishEdit[] {
  const edits: PolishEdit[] = [];
  const pattern = new RegExp(`${escapeRegExp(POLISH_EDIT_BEGIN)}\\n([\\s\\S]*?)\\n${escapeRegExp(POLISH_EDIT_SEPARATOR)}\\n?([\\s\\S]*?)\\n?${escapeRegExp(POLISH_EDIT_END)}`, "g");
  for (const match of output.matchAll(pattern)) edits.push({ from: match[1], to: match[2] });
  return edits;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// All or nothing: edits often lean on each other (deleting a sentence can
// require rewording the next one's opening), so applying only some of them
// yields text neither the writer nor the fork meant. A span that is missing,
// or appears more than once, cannot be placed without guessing.
function applyEdits(draft: string, edits: PolishEdit[]): string | null {
  let text = draft;
  for (const { from, to } of edits) {
    if (from === "") return null;
    const at = text.indexOf(from);
    if (at < 0 || text.indexOf(from, at + 1) >= 0) return null;
    text = text.slice(0, at) + to + text.slice(at + from.length);
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

// A round that edits the draft, or finds nothing to fix, stores it even when
// it also withdraws or returns: a wrong withdrawal loses a report the human
// needed, a wrong store only costs the human a read. A return beats a
// withdrawal because it reaches the writer, who can still submit nothing.
// Edits that cannot be applied store the draft as written.
function parsePolishRound(output: string, draft: string, opts: { allowReturn: boolean; kind: PolishedKind }): PolishRound | null {
  const lines = output.split("\n").map(line => line.trimStart());
  const edits = parseEdits(output);
  if (edits.length > 0 || output.includes(NO_VIOLATION_MARK)) {
    const report = (edits.length > 0 ? applyEdits(draft, edits) : null) ?? draft;
    const continueLine = opts.kind === "report" ? lines.find(line => line.startsWith(WRITER_CONTINUE_MARK)) : undefined;
    const continueReason = continueLine?.slice(WRITER_CONTINUE_MARK.length).trim();
    return { report, ...(continueReason && { continueReason }) };
  }
  const returnLine = opts.allowReturn ? lines.find(line => line.startsWith(REPORT_RETURN_MARK)) : undefined;
  if (returnLine !== undefined) return { returnedReason: returnLine.slice(REPORT_RETURN_MARK.length).trim() };
  const withdrawLine = opts.kind === "report" ? lines.find(line => line.startsWith(REPORT_WITHDRAW_MARK)) : undefined;
  if (withdrawLine === undefined) return null;
  return { withdrawnReason: withdrawLine.slice(REPORT_WITHDRAW_MARK.length).trim() };
}

// The server's env plus the fork mark, minus the worqload session identity,
// so the fork cannot reach serve's /internal routes as the writer (fetching
// the writer's feedback would drain it from the writer's inbox).
function forkEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (k === "WORQLOAD_SESSION_ID" || k === "WORQLOAD_ENDPOINT" || k === "WORQLOAD_ENDPOINT_FILE") continue;
    env[k] = v;
  }
  env[REPORT_POLISH_FORK_ENV] = "1";
  return env;
}

function collectAssistantText(parsed: { type?: string; message?: { content?: unknown } }, sink: string[]): void {
  if (parsed.type !== "assistant" || !Array.isArray(parsed.message?.content)) return;
  for (const block of parsed.message.content as { type?: string; text?: unknown }[]) {
    if (block?.type === "text" && typeof block.text === "string") sink.push(block.text);
  }
}

export function makeClaudeReportPolisher(opts: { timeoutMs?: number } = {}): ReportPolisher {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async ({ spawnCommand, cwd, draft, kind, command, allowReturn }) => {
    let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
    try {
      proc = Bun.spawn(spawnCommand, { cwd, env: forkEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch {
      return { report: draft };
    }
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, timeoutMs);

    // Each `result` line closes the turn whose assistant text accumulated
    // since the previous one.
    let turnText: string[] = [];
    const finishedTurns: string[] = [];
    let wakeTurnWaiter: (() => void) | null = null;
    const stdoutTask = readLines(proc.stdout, (line) => {
      let parsed: { type?: string; message?: { content?: unknown } };
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      collectAssistantText(parsed, turnText);
      if (isClaudePipeTurnEnd(parsed)) {
        finishedTurns.push(turnText.join(""));
        turnText = [];
        wakeTurnWaiter?.();
      }
    });
    const stderrTask = readLines(proc.stderr, () => {});
    let exited = false;
    const exitTask = proc.exited.then(() => {
      exited = true;
      wakeTurnWaiter?.();
    });

    const runTurn = async (message: string): Promise<string | null> => {
      const expected = finishedTurns.length + 1;
      try {
        proc.stdin.write(`${JSON.stringify(buildUserMessage(message))}\n`);
        await proc.stdin.flush();
      } catch {
        return null;
      }
      while (finishedTurns.length < expected && !exited) {
        await new Promise<void>(resolve => { wakeTurnWaiter = resolve; });
        wakeTurnWaiter = null;
      }
      return finishedTurns[expected - 1] ?? null;
    };

    // One round only: a second round that rechecked the rewrite cost about a
    // third of the fork's spend and changed the text in 5 of 27 polishes.
    let outcome: PolishOutcome = { report: draft };
    const rounds: string[] = [];
    try {
      const output = await runTurn(buildReportPolishInstruction(draft, { allowReturn, kind, command }));
      if (output !== null) {
        rounds.push(output);
        outcome = parsePolishRound(output, draft, { allowReturn, kind }) ?? outcome;
      }
    } finally {
      try {
        proc.stdin.end();
      } catch {
        // already closed
      }
      await exitTask;
      clearTimeout(timer);
      await Promise.allSettled([stdoutTask, stderrTask]);
    }
    return { ...outcome, rounds };
  };
}
