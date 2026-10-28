import { expect, test } from "bun:test";
import { join } from "path";
import {
  buildReportPolishInstruction,
  makeClaudeReportPolisher,
  POLISHED_REPORT_BEGIN,
  POLISHED_REPORT_END,
  NO_VIOLATION_MARK,
  REPORT_POLISH_FORK_ENV,
  REPORT_RETURN_MARK,
  REPORT_WITHDRAW_MARK,
  type PolishOutcome,
} from "./report-polish";

const MOCK = join(import.meta.dir, "__fixtures__", "mock-claude.ts");

function polishedReply(report: string, opts: { clean?: boolean } = {}): string {
  return [
    "作法の列挙",
    opts.clean ? NO_VIOLATION_MARK : "違反の書き出し",
    POLISHED_REPORT_BEGIN,
    report,
    POLISHED_REPORT_END,
  ].join("\n");
}

function describeOutcome(outcome: PolishOutcome): string {
  if ("report" in outcome) return outcome.report;
  return "returnedReason" in outcome ? `returned: ${outcome.returnedReason}` : `withdrawn: ${outcome.withdrawnReason}`;
}

function polishWith(replies: string[], overrides: { draft?: string; allowReturn?: boolean } = {}) {
  const polish = makeClaudeReportPolisher();
  return polish({
    spawnCommand: ["bun", MOCK, "replies", ...replies],
    cwd: process.cwd(),
    draft: overrides.draft ?? "原稿",
    allowReturn: overrides.allowReturn ?? true,
  }).then(describeOutcome);
}

function withdrawReply(reason: string): string {
  return ["価値の判断", `${REPORT_WITHDRAW_MARK} ${reason}`].join("\n");
}

function returnReply(reason: string): string {
  return ["論理と調査の判断", `${REPORT_RETURN_MARK} ${reason}`].join("\n");
}

test("a first round that finds no violation is stored without a second round", async () => {
  // The mock answers a second message with a placeholder, so a stray second
  // round would surface as that placeholder instead of the first round's text.
  expect(await polishWith([polishedReply("推敲版その1", { clean: true })])).toBe("推敲版その1");
});

test("a first round that rewrote the draft is checked once more and the second round's text is stored", async () => {
  expect(await polishWith([polishedReply("推敲版その1"), polishedReply("推敲版その2")])).toBe("推敲版その2");
});

test("the second round's text is stored even when it still reports violations", async () => {
  // Two rounds is the ceiling: a third message would get the placeholder.
  expect(await polishWith([polishedReply("推敲版その1"), polishedReply("推敲版その2"), polishedReply("推敲版その3")]))
    .toBe("推敲版その2");
});

test("the draft and the marks reach the fork's instruction", () => {
  const instruction = buildReportPolishInstruction("提出された原稿", { allowReturn: true });
  expect(instruction).toContain("提出された原稿");
  expect(instruction).toContain(POLISHED_REPORT_BEGIN);
  expect(instruction).toContain(POLISHED_REPORT_END);
  expect(instruction).toContain(NO_VIOLATION_MARK);
  expect(instruction).toContain(REPORT_WITHDRAW_MARK);
  expect(instruction).toContain(REPORT_RETURN_MARK);
});

test("an instruction for a draft that may not be returned again leaves out the return mark", () => {
  expect(buildReportPolishInstruction("提出された原稿", { allowReturn: false })).not.toContain(REPORT_RETURN_MARK);
});

test("the fork runs with the polish mark and without the session identity", async () => {
  const out = await polishWith([
    polishedReply(`mark=[{{env:${REPORT_POLISH_FORK_ENV}}}] session=[{{env:WORQLOAD_SESSION_ID}}]`, { clean: true }),
  ]);
  expect(out).toBe("mark=[1] session=[]");
});

test("an output without the report markers falls back to the draft", async () => {
  expect(await polishWith(["全文の区切りがない応答"], { draft: "失いたくない原稿" })).toBe("失いたくない原稿");
});

test("a second round without the report markers keeps the first round's text", async () => {
  expect(await polishWith([polishedReply("推敲版その1"), "区切りがない応答"])).toBe("推敲版その1");
});

test("a fork that exits non-zero falls back to the draft", async () => {
  const polish = makeClaudeReportPolisher();
  const out = await polish({ spawnCommand: ["bun", MOCK, "crash"], cwd: process.cwd(), draft: "原稿", allowReturn: true });
  expect(out).toEqual({ report: "原稿" });
});

test("a fork that never answers is killed at the timeout and the draft is stored", async () => {
  const polish = makeClaudeReportPolisher({ timeoutMs: 300 });
  const out = await polish({ spawnCommand: ["bun", MOCK, "hang"], cwd: process.cwd(), draft: "原稿", allowReturn: true });
  expect(out).toEqual({ report: "原稿" });
});

test("a first round that withdraws the report ends the polish with the fork's reason", async () => {
  expect(await polishWith([withdrawReply("人間の知っていることを何も変えない")])).toBe("withdrawn: 人間の知っていることを何も変えない");
});

test("a second round may withdraw the report the first round rewrote", async () => {
  expect(await polishWith([polishedReply("推敲版その1"), withdrawReply("前のレポートと同じ内容")])).toBe("withdrawn: 前のレポートと同じ内容");
});

test("a round that both withdraws and writes a report is read as the report", async () => {
  // Storing is the safe reading of a contradictory answer: a wrong withdrawal
  // loses a report, a wrong store only costs the human a read.
  expect(await polishWith([`${withdrawReply("不要")}\n${polishedReply("推敲版", { clean: true })}`])).toBe("推敲版");
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
