import { test, expect } from "bun:test";
import { join } from "path";
import { buildReportRewritePrompt, ESCALATE_SENTINEL, makeClaudeReportRewriter, makeCodexReportRewriter, makeCursorReportRewriter, SUPPRESS_SENTINEL } from "./report-rewriter";

const MOCK = join(import.meta.dir, "__fixtures__", "mock-claude.ts");
const MOCK_CODEX = join(import.meta.dir, "__fixtures__", "mock-codex.ts");
const MOCK_CURSOR = join(import.meta.dir, "__fixtures__", "mock-cursor.ts");
const CURSOR_PREFIX = ["-p", "--output-format", "stream-json", "--force", "--trust"];

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
  if (typeof out !== "string") throw new Error("echo mode must produce a rewritten string");
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

test("buildReportRewritePrompt hands the agent the exact suppression sentinel", () => {
  // The agent can only suppress a report by emitting this exact string. If the
  // prompt and the exported constant drift apart, suppression silently never
  // fires — so the wiring between them is worth pinning.
  expect(buildReportRewritePrompt("x")).toContain(SUPPRESS_SENTINEL);
});

test("makeClaudeReportRewriter returns null when the agent emits the suppression sentinel", async () => {
  // The agent's signal that the report is not worth the human's time.
  const rewrite = makeClaudeReportRewriter({ spawnCommand: ["bun", MOCK, "say", SUPPRESS_SENTINEL] });
  expect(await rewrite("不要な本文", { cwd: process.cwd() })).toBeNull();
});

test("makeClaudeReportRewriter stores sentinel-plus-text as an ordinary rewrite", async () => {
  // Suppression fires only on the sentinel standing alone. Any other output —
  // even one that happens to contain the sentinel — is kept, so a stray token
  // can never silently drop a report.
  const rewrite = makeClaudeReportRewriter({
    spawnCommand: ["bun", MOCK, "say", `${SUPPRESS_SENTINEL} まだ本文がある`],
  });
  const out = await rewrite("本文", { cwd: process.cwd() });
  expect(out).not.toBeNull();
  expect(out).toContain("まだ本文がある");
});

test("buildReportRewritePrompt hands the agent the exact escalate sentinel", () => {
  // Same wiring concern as the suppression sentinel: if the prompt and the
  // exported constant drift apart, the escalate verdict silently never fires.
  expect(buildReportRewritePrompt("x")).toContain(ESCALATE_SENTINEL);
});

test("makeClaudeReportRewriter returns the escalate verdict when the agent emits the escalate sentinel", async () => {
  // The agent's signal that the report is really a request for a decision and
  // belongs in an Escalation, not a Report.
  const rewrite = makeClaudeReportRewriter({ spawnCommand: ["bun", MOCK, "say", ESCALATE_SENTINEL] });
  expect(await rewrite("これでよいか確認したい", { cwd: process.cwd() })).toEqual({ escalate: true });
});

test("makeClaudeReportRewriter stores escalate-sentinel-plus-text as an ordinary rewrite", async () => {
  // The escalate verdict, like suppression, fires only on the sentinel standing
  // alone — a stray token can never silently reroute a real report.
  const rewrite = makeClaudeReportRewriter({
    spawnCommand: ["bun", MOCK, "say", `${ESCALATE_SENTINEL} まだ本文がある`],
  });
  const out = await rewrite("本文", { cwd: process.cwd() });
  expect(out).toEqual(expect.stringContaining("まだ本文がある"));
});

test("makeCodexReportRewriter spawns `codex exec --json -` and returns its rewritten text", async () => {
  // echo mode echoes the stdin (the rewrite prompt) back as one agent_message
  // item; the rewriter strips down to that text. Pinning that the codex
  // invocation actually used the spawnCommand prefix we supplied.
  const rewrite = makeCodexReportRewriter({ spawnCommand: ["bun", MOCK_CODEX, "echo"] });
  const out = await rewrite("もとの本文", { cwd: process.cwd() });
  if (typeof out !== "string") throw new Error("echo mode must produce a rewritten string");
  expect(out.startsWith("echo:")).toBe(true);
  expect(out).toContain("もとの本文");
});

test("makeCodexReportRewriter falls back to the raw report when codex exits non-zero", async () => {
  const rewrite = makeCodexReportRewriter({ spawnCommand: ["bun", MOCK_CODEX, "crash"] });
  const raw = "失っては困る本文";
  expect(await rewrite(raw, { cwd: process.cwd() })).toBe(raw);
});

test("makeCodexReportRewriter falls back to the raw report when the command cannot be spawned", async () => {
  const rewrite = makeCodexReportRewriter({ spawnCommand: ["definitely-not-a-real-binary-xyz"] });
  const raw = "起動失敗でも残る本文";
  expect(await rewrite(raw, { cwd: process.cwd() })).toBe(raw);
});

test("makeCodexReportRewriter returns null when codex emits the suppression sentinel as the sole agent_message text", async () => {
  const rewrite = makeCodexReportRewriter({
    spawnCommand: ["bun", MOCK_CODEX, "say", SUPPRESS_SENTINEL],
  });
  expect(await rewrite("不要な本文", { cwd: process.cwd() })).toBeNull();
});

test("makeCodexReportRewriter returns the escalate verdict when codex emits the escalate sentinel alone", async () => {
  const rewrite = makeCodexReportRewriter({
    spawnCommand: ["bun", MOCK_CODEX, "say", ESCALATE_SENTINEL],
  });
  expect(await rewrite("これでよいか", { cwd: process.cwd() })).toEqual({ escalate: true });
});

test("makeCodexReportRewriter stores sentinel-plus-text as an ordinary rewrite", async () => {
  // Same wiring concern as the claude path: only the bare sentinel triggers
  // suppression / escalate, so a stray token can't silently drop or reroute
  // a real report.
  const rewrite = makeCodexReportRewriter({
    spawnCommand: ["bun", MOCK_CODEX, "say", `${SUPPRESS_SENTINEL} まだ本文がある`],
  });
  const out = await rewrite("本文", { cwd: process.cwd() });
  expect(out).not.toBeNull();
  expect(out).toContain("まだ本文がある");
});

test("makeCursorReportRewriter spawns agent -p and returns its rewritten text", async () => {
  const rewrite = makeCursorReportRewriter({
    spawnCommand: ["bun", MOCK_CURSOR, "echo", ...CURSOR_PREFIX],
  });
  const out = await rewrite("もとの本文", { cwd: process.cwd() });
  if (typeof out !== "string") throw new Error("echo mode must produce a rewritten string");
  expect(out.startsWith("echo:")).toBe(true);
  expect(out).toContain("もとの本文");
});

test("makeCursorReportRewriter falls back to the raw report when agent exits non-zero", async () => {
  const rewrite = makeCursorReportRewriter({
    spawnCommand: ["bun", MOCK_CURSOR, "crash", ...CURSOR_PREFIX],
  });
  const raw = "失っては困る本文";
  expect(await rewrite(raw, { cwd: process.cwd() })).toBe(raw);
});
