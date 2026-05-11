import { expect, test } from "bun:test";
import { describeEvent } from "../web/events-view.js";

test("describeEvent renders a session_started prompt", () => {
  const d = describeEvent({
    seq: 1,
    kind: "session_started",
    timestamp: "",
    payload: { prompt: "fix the parser\nthen test" },
  });
  expect(d.summary).toBe("fix the parser then test");
  expect(d.sections).toEqual([{ label: "Prompt", body: "fix the parser\nthen test", format: "text" }]);
});

test("describeEvent extracts assistant message text and offers it as markdown", () => {
  const payload = { type: "assistant", message: { content: [{ type: "text", text: "## done\n\nshipped it" }] } };
  const d = describeEvent({ seq: 2, kind: "claude_assistant_message", timestamp: "", payload });
  expect(d.summary).toBe("## done shipped it");
  expect(d.sections).toEqual([{ label: "Message", body: "## done\n\nshipped it", format: "markdown" }]);
});

test("describeEvent summarises a tool_use by name and key argument", () => {
  const payload = {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "bun test", description: "run tests" } }],
    },
  };
  const d = describeEvent({ seq: 3, kind: "claude_tool_use", timestamp: "", payload });
  expect(d.summary).toBe("Bash $ bun test");
  expect(d.sections).toEqual([
    { label: "Bash", body: JSON.stringify({ command: "bun test", description: "run tests" }, null, 2), format: "code" },
  ]);
});

test("describeEvent summarises a Read tool_use by file path", () => {
  const payload = {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/a/b.ts" } }] },
  };
  const d = describeEvent({ seq: 4, kind: "claude_tool_use", timestamp: "", payload });
  expect(d.summary).toBe("Read /a/b.ts");
});

test("describeEvent flattens a tool_result, marking errors", () => {
  const ok = describeEvent({
    seq: 5,
    kind: "claude_tool_result",
    timestamp: "",
    payload: {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "12 pass\n0 fail" }] }],
      },
    },
  });
  expect(ok.summary).toBe("12 pass 0 fail");
  expect(ok.sections).toEqual([{ label: "Tool result", body: "12 pass\n0 fail", format: "code" }]);

  const err = describeEvent({
    seq: 6,
    kind: "claude_tool_result",
    timestamp: "",
    payload: {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "x", is_error: true, content: "boom" }] },
    },
  });
  expect(err.summary).toBe("⚠ boom");
  expect(err.sections).toEqual([{ label: "Tool result (error)", body: "boom", format: "code" }]);
});

test("describeEvent surfaces stderr lines from claude_system", () => {
  const d = describeEvent({
    seq: 7,
    kind: "claude_system",
    timestamp: "",
    payload: { type: "stderr", text: "deprecation warning" },
  });
  expect(d.summary).toBe("deprecation warning");
  expect(d.sections).toEqual([{ label: "stderr", body: "deprecation warning", format: "code" }]);
});

test("describeEvent gives file events a friendly summary", () => {
  expect(
    describeEvent({ seq: 8, kind: "report_submitted", timestamp: "", payload: { filename: "003-foo.md" } }).summary,
  ).toBe("📄 003-foo.md");
  expect(
    describeEvent({ seq: 9, kind: "escalation_requested", timestamp: "", payload: { filename: "001-x.md" } }).summary,
  ).toBe("🙋 001-x.md");
  expect(
    describeEvent({ seq: 10, kind: "feedback_received", timestamp: "", payload: { filename: "002-y.md" } }).summary,
  ).toBe("✉ 002-y.md");
  expect(describeEvent({ seq: 11, kind: "feedback_fetched", timestamp: "", payload: { count: 2 } }).summary).toBe(
    "2 messages fetched",
  );
  expect(describeEvent({ seq: 12, kind: "feedback_fetched", timestamp: "", payload: { count: 1 } }).summary).toBe(
    "1 message fetched",
  );
  expect(describeEvent({ kind: "report_read", payload: { filename: "001-x.md" } }).summary).toBe("✓ read 001-x.md");
  expect(describeEvent({ kind: "report_read", payload: { filenames: ["001-x.md", "003-y.md"] } }).summary).toBe(
    "✓ read 2 reports",
  );
  expect(describeEvent({ kind: "report_read", payload: { filenames: ["001-x.md"] } }).summary).toBe("✓ read 1 report");
});

test("describeEvent summarises an action_invoked run and exposes its output", () => {
  const d = describeEvent({
    seq: 13,
    kind: "action_invoked",
    timestamp: "",
    payload: {
      actionId: "merge",
      label: "Merge to base",
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "conflict in a.ts",
      message: "merge failed",
    },
  });
  expect(d.summary).toBe("✗ Merge to base (exit 1)");
  expect(d.sections).toEqual([
    { label: "stderr", body: "conflict in a.ts", format: "code" },
    { label: "message", body: "merge failed", format: "text" },
  ]);
});

test("describeEvent falls back to pretty-printed payload for unknown shapes", () => {
  const payload = { type: "system", subtype: "init", tools: ["Read"] };
  const d = describeEvent({ seq: 14, kind: "claude_system", timestamp: "", payload });
  expect(d.summary).toBe("system: init");
  expect(d.sections).toEqual([{ label: "Payload", body: JSON.stringify(payload, null, 2), format: "code" }]);
});

test("describeEvent never throws on a missing or malformed payload", () => {
  expect(() => describeEvent({ seq: 15, kind: "claude_assistant_message", timestamp: "" })).not.toThrow();
  expect(() => describeEvent({})).not.toThrow();
  expect(() => describeEvent(null)).not.toThrow();
});
