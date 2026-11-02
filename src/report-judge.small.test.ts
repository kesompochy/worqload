import { expect, test } from "bun:test";
import { buildReportJudgeInstruction, JUDGE_ACCEPT_MARK, JUDGE_REJECT_MARK, parseJudgeVerdict } from "./report-judge";

test("the task, what the human has seen, and the draft reach the judge's instruction", () => {
  const instruction = buildReportJudgeInstruction({
    task: "最初のタスク",
    timeline: [
      { kind: "human", text: "人間の発言" },
      { kind: "report", text: "見せたレポート" },
    ],
    draft: "判定する原稿",
  });
  for (const text of ["最初のタスク", "人間の発言", "見せたレポート", "判定する原稿", JUDGE_ACCEPT_MARK, JUDGE_REJECT_MARK]) {
    expect(instruction).toContain(text);
  }
  expect(instruction).not.toContain("{{");
});

test("a reject verdict carries the sentence before it as the reason", () => {
  expect(parseJudgeVerdict(`判断の記述\n冒頭の文が書き手の作業の記録になっている。\n${JUDGE_REJECT_MARK}`)).toBe("冒頭の文が書き手の作業の記録になっている。");
});

test("an accept verdict, or an answer with no verdict, carries no reason", () => {
  expect(parseJudgeVerdict(`問題は無い。\n${JUDGE_ACCEPT_MARK}`)).toBeNull();
  expect(parseJudgeVerdict("判定の行が無い応答")).toBeNull();
});

test("the last verdict line decides when the answer quotes the other mark earlier", () => {
  expect(parseJudgeVerdict(`${JUDGE_REJECT_MARK} とすべきか迷ったが\n読める。\n${JUDGE_ACCEPT_MARK}`)).toBeNull();
});
