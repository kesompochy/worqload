import { test, expect } from "bun:test";
import { join } from "path";
import { buildReportRewritePrompt, makeClaudeReportRewriter } from "./report-rewriter";

const MOCK = join(import.meta.dir, "__fixtures__", "mock-claude.ts");

test("buildReportRewritePrompt embeds the raw report and the human-readability guidance", () => {
  const prompt = buildReportRewritePrompt("生のレポート本文");
  // The text being rewritten must reach the agent verbatim.
  expect(prompt).toContain("生のレポート本文");
  // The two principles the human named explicitly.
  expect(prompt).toContain("結論");
  expect(prompt).toContain("一文");
  // Reports are written in Japanese (see CLAUDE.md); the rewrite must stay so.
  expect(prompt).toContain("日本語");
  // It is a pure text transform: the agent must emit only the rewritten
  // markdown ("〜のみ") and not reach for tools.
  expect(prompt).toContain("のみ");
  expect(prompt).toContain("ツールは使わない");
});

test("makeClaudeReportRewriter spawns the configured command and returns its rewritten text", async () => {
  // echo mode replies `echo: <the stream-json user message text>` — proves the
  // rewriter spawned exactly the given command, fed it the prompt over
  // stream-json stdin, and harvested the assistant text back.
  const rewrite = makeClaudeReportRewriter({ spawnCommand: ["bun", MOCK, "echo"] });
  const out = await rewrite("もとの本文", { cwd: process.cwd() });
  expect(out.startsWith("echo:")).toBe(true);
  expect(out).toContain("もとの本文");
});

test("makeClaudeReportRewriter falls back to the raw report when the agent exits non-zero", async () => {
  // crash mode exits 1 without producing assistant text. Losing the report
  // because the polisher failed is unacceptable — return the original.
  const rewrite = makeClaudeReportRewriter({ spawnCommand: ["bun", MOCK, "crash"] });
  const raw = "失っては困る本文";
  expect(await rewrite(raw, { cwd: process.cwd() })).toBe(raw);
});

test("makeClaudeReportRewriter falls back to the raw report when the command cannot be spawned", async () => {
  const rewrite = makeClaudeReportRewriter({ spawnCommand: ["definitely-not-a-real-binary-xyz"] });
  const raw = "起動失敗でも残る本文";
  expect(await rewrite(raw, { cwd: process.cwd() })).toBe(raw);
});
