import { expect, test } from "bun:test";
import { join } from "path";
import {
  buildReportPolishInstruction,
  makeClaudeReportPolisher,
  POLISHED_REPORT_BEGIN,
  POLISHED_REPORT_END,
  NO_VIOLATION_MARK,
  REPORT_POLISH_FORK_ENV,
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

function polishWith(replies: string[], overrides: { draft?: string } = {}) {
  const polish = makeClaudeReportPolisher();
  return polish({
    spawnCommand: ["bun", MOCK, "replies", ...replies],
    cwd: process.cwd(),
    draft: overrides.draft ?? "原稿",
    unreadPolished: [],
  });
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

test("the draft and the polished versions the writer has not fetched reach the fork's instruction", () => {
  const instruction = buildReportPolishInstruction("提出された原稿", ["未取得の推敲版A", "未取得の推敲版B"]);
  expect(instruction).toContain("提出された原稿");
  expect(instruction).toContain("未取得の推敲版A");
  expect(instruction).toContain("未取得の推敲版B");
  expect(instruction).toContain(POLISHED_REPORT_BEGIN);
  expect(instruction).toContain(POLISHED_REPORT_END);
  expect(instruction).toContain(NO_VIOLATION_MARK);
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
  const out = await polish({ spawnCommand: ["bun", MOCK, "crash"], cwd: process.cwd(), draft: "原稿", unreadPolished: [] });
  expect(out).toBe("原稿");
});

test("a fork that never answers is killed at the timeout and the draft is stored", async () => {
  const polish = makeClaudeReportPolisher({ timeoutMs: 300 });
  const out = await polish({ spawnCommand: ["bun", MOCK, "hang"], cwd: process.cwd(), draft: "原稿", unreadPolished: [] });
  expect(out).toBe("原稿");
});
