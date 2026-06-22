import { expect, test } from "bun:test";
import { describeEvent, displayEventKind, isAgentWorkEvent } from "../web/events-view.js";

test("isAgentWorkEvent: agent run and its steps count as work", () => {
  for (const kind of [
    "session_started",
    "session_resumed",
    "session_auto_resumed",
    "claude_assistant_message",
    "claude_tool_use",
    "claude_tool_result",
    "claude_system",
    "session_stopped",
    "session_crashed",
  ]) {
    expect(isAgentWorkEvent({ kind })).toBe(true);
  }
});

test("isAgentWorkEvent: reports, feedback, escalations and actions are not work", () => {
  for (const kind of [
    "report_submitted",
    "report_read",
    "report_unread",
    "escalation_requested",
    "escalation_resolved",
    "feedback_received",
    "feedback_fetched",
    "action_invoked",
  ]) {
    expect(isAgentWorkEvent({ kind })).toBe(false);
  }
  expect(isAgentWorkEvent(null)).toBe(false);
  expect(isAgentWorkEvent({})).toBe(false);
});

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

test("displayEventKind labels agent events for the configured agent", () => {
  expect(displayEventKind({ kind: "claude_tool_use" }, "claude")).toBe("Claude tool use");
  expect(displayEventKind({ kind: "claude_tool_use" }, "codex")).toBe("Codex tool use");
  expect(displayEventKind({ kind: "claude_tool_use" }, "cursor")).toBe("Cursor tool use");
  expect(displayEventKind({ kind: "session_started" }, "codex")).toBe("session_started");
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

test("describeEvent renders an approved command-approval resolve with its output", () => {
  const payload = {
    filename: "001-command-approval.md",
    decision: "approve",
    command: "git log --oneline -3",
    exitCode: 0,
    stdout: "abc one\ndef two\n",
    stderr: "",
  };
  const d = describeEvent({ seq: 20, kind: "escalation_resolved", timestamp: "", payload });
  expect(d.summary).toBe("✅ approved & ran: git log --oneline -3 (exit 0)");
  expect(d.sections).toEqual([
    { label: "command", body: "git log --oneline -3", format: "code" },
    { label: "stdout", body: "abc one\ndef two\n", format: "code" },
  ]);
});

test("describeEvent renders a rejected command-approval resolve", () => {
  const payload = { filename: "001-command-approval.md", decision: "reject", command: "npm publish" };
  const d = describeEvent({ seq: 21, kind: "escalation_resolved", timestamp: "", payload });
  expect(d.summary).toBe("🚫 rejected: npm publish");
});

test("describeEvent shows the command in a command-approval request summary", () => {
  const d = describeEvent({
    seq: 22,
    kind: "escalation_requested",
    timestamp: "",
    payload: { filename: "001-command-approval.md", command: "docker system prune -af" },
  });
  expect(d.summary).toBe("🙋 approval: $ docker system prune -af");
});
