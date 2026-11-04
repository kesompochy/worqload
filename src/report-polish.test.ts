import { expect, test } from "bun:test";
import { join } from "path";
import {
  buildReportPolishInstruction,
  makeClaudeReportPolisher,
  POLISH_EDIT_BEGIN,
  POLISH_EDIT_END,
  POLISH_EDIT_SEPARATOR,
  NO_VIOLATION_MARK,
  REPORT_POLISH_FORK_ENV,
  REPORT_RETURN_MARK,
  REPORT_WITHDRAW_MARK,
  WRITER_CONTINUE_MARK,
  type PolishOutcome,
} from "./report-polish";

const MOCK = join(import.meta.dir, "__fixtures__", "mock-claude.ts");

function editReply(edits: [from: string, to: string][]): string {
  return ["判断", ...edits.flatMap(([from, to]) => [POLISH_EDIT_BEGIN, from, POLISH_EDIT_SEPARATOR, ...(to === "" ? [] : [to]), POLISH_EDIT_END])].join("\n");
}

// The default draft is "原稿", so replacing it whole stands in for any rewrite.
function polishedReply(report: string): string {
  return editReply([["原稿", report]]);
}

function cleanReply(): string {
  return ["判断", NO_VIOLATION_MARK].join("\n");
}

function describeOutcome(outcome: PolishOutcome): string {
  if ("report" in outcome) return outcome.continueReason ? `${outcome.report} / continue: ${outcome.continueReason}` : outcome.report;
  return "returnedReason" in outcome ? `returned: ${outcome.returnedReason}` : `withdrawn: ${outcome.withdrawnReason}`;
}

function polishWith(replies: string[], overrides: { draft?: string; allowReturn?: boolean; kind?: "report" | "escalation" | "command"; command?: string } = {}) {
  const polish = makeClaudeReportPolisher();
  return polish({
    spawnCommand: ["bun", MOCK, "replies", ...replies],
    cwd: process.cwd(),
    draft: overrides.draft ?? "原稿",
    allowReturn: overrides.allowReturn ?? true,
    kind: overrides.kind ?? "report",
    ...(overrides.command !== undefined && { command: overrides.command }),
  }).then(describeOutcome);
}

function withdrawReply(reason: string): string {
  return ["価値の判断", `${REPORT_WITHDRAW_MARK} ${reason}`].join("\n");
}

function returnReply(reason: string): string {
  return ["論理と調査の判断", `${REPORT_RETURN_MARK} ${reason}`].join("\n");
}

test("a rewrite is stored without a second round, even when it reported violations", async () => {
  expect(await polishWith([polishedReply("推敲版その1"), polishedReply("推敲版その2")])).toBe("推敲版その1");
});

test("the draft and the marks reach the fork's instruction", () => {
  const instruction = buildReportPolishInstruction("提出された原稿", { allowReturn: true, kind: "report" });
  expect(instruction).toContain("提出された原稿");
  expect(instruction).toContain(POLISH_EDIT_BEGIN);
  expect(instruction).toContain(POLISH_EDIT_END);
  expect(instruction).toContain(NO_VIOLATION_MARK);
  expect(instruction).toContain(REPORT_WITHDRAW_MARK);
  expect(instruction).toContain(REPORT_RETURN_MARK);
});

test("an instruction for a draft that may not be returned again leaves out the return mark", () => {
  expect(buildReportPolishInstruction("提出された原稿", { allowReturn: false, kind: "report" })).not.toContain(REPORT_RETURN_MARK);
});

test("the fork runs with the polish mark and without the session identity", async () => {
  const out = await polishWith([
    polishedReply(`mark=[{{env:${REPORT_POLISH_FORK_ENV}}}] session=[{{env:WORQLOAD_SESSION_ID}}]`),
  ]);
  expect(out).toBe("mark=[1] session=[]");
});

test("an output without the report markers falls back to the draft", async () => {
  expect(await polishWith(["全文の区切りがない応答"], { draft: "失いたくない原稿" })).toBe("失いたくない原稿");
});

test("a fork that exits non-zero falls back to the draft", async () => {
  const polish = makeClaudeReportPolisher();
  const out = await polish({ spawnCommand: ["bun", MOCK, "crash"], cwd: process.cwd(), draft: "原稿", allowReturn: true, kind: "report" });
  expect(out).toEqual({ report: "原稿", rounds: [] });
});

test("a fork that never answers is killed at the timeout and the draft is stored", async () => {
  const polish = makeClaudeReportPolisher({ timeoutMs: 300 });
  const out = await polish({ spawnCommand: ["bun", MOCK, "hang"], cwd: process.cwd(), draft: "原稿", allowReturn: true, kind: "report" });
  expect(out).toEqual({ report: "原稿", rounds: [] });
});

test("a first round that withdraws the report ends the polish with the fork's reason", async () => {
  expect(await polishWith([withdrawReply("人間の知っていることを何も変えない")])).toBe("withdrawn: 人間の知っていることを何も変えない");
});

test("a round that both withdraws and writes a report is read as the report", async () => {
  // Storing is the safe reading of a contradictory answer: a wrong withdrawal
  // loses a report, a wrong store only costs the human a read.
  expect(await polishWith([`${withdrawReply("不要")}\n${polishedReply("推敲版")}`])).toBe("推敲版");
});

test("a round that returns the report ends the polish with what the fork found missing", async () => {
  expect(await polishWith([returnReply("結論の根拠になる調査がない")])).toBe("returned: 結論の根拠になる調査がない");
});

test("a return is ignored for a draft that may not be returned again", async () => {
  expect(await polishWith([returnReply("調査がない")], { draft: "出し直した原稿", allowReturn: false })).toBe("出し直した原稿");
});

test("a round that both returns and withdraws the report is read as the return", async () => {
  // A return reaches the writer, who can still decide to submit nothing; a
  // withdrawal drops the report without the writer knowing.
  expect(await polishWith([`${withdrawReply("不要")}\n${returnReply("調査がない")}`])).toBe("returned: 調査がない");
});

test("an escalation's instruction carries the draft and the return mark but not the withdraw mark", () => {
  const instruction = buildReportPolishInstruction("提出された問い", { allowReturn: true, kind: "escalation" });
  expect(instruction).toContain("提出された問い");
  expect(instruction).toContain(POLISH_EDIT_BEGIN);
  expect(instruction).toContain(REPORT_RETURN_MARK);
  expect(instruction).not.toContain(REPORT_WITHDRAW_MARK);
  expect(instruction).not.toContain("{{");
});

test("an escalation may not be returned again once returned", () => {
  expect(buildReportPolishInstruction("提出された問い", { allowReturn: false, kind: "escalation" })).not.toContain(REPORT_RETURN_MARK);
});

test("an escalation is never withdrawn, since its writer waits for the answer", async () => {
  expect(await polishWith([withdrawReply("不要")], { draft: "問いの原稿", kind: "escalation" })).toBe("問いの原稿");
});

test("an escalation may be returned to its writer", async () => {
  expect(await polishWith([returnReply("自分で決められる")], { kind: "escalation" })).toBe("returned: 自分で決められる");
});

test("the polish carries the fork's output, and only one round of it", async () => {
  const polish = makeClaudeReportPolisher();
  const out = await polish({
    spawnCommand: ["bun", MOCK, "replies", polishedReply("推敲版その1"), polishedReply("推敲版その2")],
    cwd: process.cwd(),
    draft: "原稿",
    allowReturn: true,
    kind: "report",
  });
  expect(out.rounds).toEqual([polishedReply("推敲版その1")]);
});

test("a command approval's instruction carries the reason, the command it must not change, and the return mark but not the withdraw mark", () => {
  const instruction = buildReportPolishInstruction("承認依頼の理由", { allowReturn: true, kind: "command", command: "gh pr create --body-file pr.md" });
  expect(instruction).toContain("承認依頼の理由");
  expect(instruction).toContain("gh pr create --body-file pr.md");
  expect(instruction).toContain(REPORT_RETURN_MARK);
  expect(instruction).not.toContain(REPORT_WITHDRAW_MARK);
  expect(instruction).not.toContain("{{");
});

test("a command approval is never withdrawn, since its writer waits for the decision", async () => {
  expect(await polishWith([withdrawReply("不要")], { draft: "理由の原稿", kind: "command", command: "npm publish" })).toBe("理由の原稿");
});

test("a report's instruction carries the continue mark, an escalation's does not", () => {
  expect(buildReportPolishInstruction("原稿", { allowReturn: true, kind: "report" })).toContain(WRITER_CONTINUE_MARK);
  expect(buildReportPolishInstruction("原稿", { allowReturn: true, kind: "escalation" })).not.toContain(WRITER_CONTINUE_MARK);
});

test("a continue line after the report keeps the report and carries what the writer should go on with", async () => {
  const reply = `${polishedReply("推敲版")}\n${WRITER_CONTINUE_MARK} 人間の質問に答えていない`;
  expect(await polishWith([reply])).toBe("推敲版 / continue: 人間の質問に答えていない");
});


test("an escalation's continue line is ignored, since its writer waits for the answer", async () => {
  const reply = `${polishedReply("推敲された問い")}\n${WRITER_CONTINUE_MARK} 続けよ`;
  expect(await polishWith([reply], { kind: "escalation" })).toBe("推敲された問い");
});

test("edits change only the text they name and leave the rest of the draft as written", async () => {
  const draft = "一文目。二文目。三文目。";
  expect(await polishWith([editReply([["二文目。", ""], ["三文目", "最後の文"]])], { draft })).toBe("一文目。最後の文。");
});

test("deleting a paragraph leaves a single blank line between its neighbours", async () => {
  const draft = "前の段落。\n\n消す段落。\n\n後の段落。";
  expect(await polishWith([editReply([["消す段落。", ""]])], { draft })).toBe("前の段落。\n\n後の段落。");
});

test("an edit whose text is not in the draft leaves every edit unapplied", async () => {
  const draft = "一文目。二文目。";
  expect(await polishWith([editReply([["一文目。", ""], ["原稿に無い文。", "x"]])], { draft })).toBe(draft);
});

test("an edit whose text appears more than once leaves every edit unapplied", async () => {
  const draft = "同じ文。同じ文。";
  expect(await polishWith([editReply([["同じ文。", ""]])], { draft })).toBe(draft);
});

test("a round that finds nothing to fix stores the draft as written", async () => {
  expect(await polishWith([cleanReply()], { draft: "直すところのない原稿" })).toBe("直すところのない原稿");
});

test("a reader's objection reaches the fork's instruction only when there is one", () => {
  expect(buildReportPolishInstruction("原稿", { allowReturn: true, kind: "report", readerObjection: "冒頭が作業の記録になっている" })).toContain("冒頭が作業の記録になっている");
  const without = buildReportPolishInstruction("原稿", { allowReturn: true, kind: "report" });
  expect(without).not.toContain("{{");
  expect(without).not.toContain("readerObjection");
});

test("the count of unread reports merged into the draft reaches the fork's instruction only when there are some", () => {
  const merged = buildReportPolishInstruction("原稿", { allowReturn: true, kind: "report", mergedReportCount: 2 });
  const alone = buildReportPolishInstruction("原稿", { allowReturn: true, kind: "report" });
  expect(merged).not.toContain("{{");
  expect(alone).not.toContain("{{");
  expect(merged.length).toBeGreaterThan(alone.length);
});
