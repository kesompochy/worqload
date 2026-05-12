// Turns one raw NDJSON event into what the Events tab shows for it: a one-line
// summary for the collapsed row, and the sections of the expand panel — an
// assistant turn as markdown, tool calls as name + arguments, tool results /
// stderr as code, lifecycle and report/feedback events as a short sentence. For
// kinds we don't special-case (and as a fallback when extraction fails) the
// panel falls back to the pretty-printed payload. This module is pure; the
// painting lives in web/svelte/EventsView.svelte.

// ---- pure: event -> { summary, sections } -------------------------------
//
// summary  : one line for the collapsed row.
// sections : the expanded panel, in order. Each is { label, body, format }
//            where format is "markdown" | "text" | "code".

export function describeEvent(event) {
  const kind = event?.kind;
  const payload = event?.payload;
  switch (kind) {
    case "session_started":
    case "session_resumed": {
      const prompt = String(payload?.prompt ?? "");
      return {
        summary: oneLine(prompt) || (kind === "session_resumed" ? "resumed" : "started"),
        sections: [{ label: "Prompt", body: prompt, format: "text" }],
      };
    }

    case "claude_assistant_message": {
      const text = assistantText(payload);
      if (text) return { summary: oneLine(text), sections: [{ label: "Message", body: text, format: "markdown" }] };
      const thinking = blocksOfType(payload, "thinking").map(b => b.thinking).filter(t => typeof t === "string").join("\n").trim();
      if (thinking) return { summary: oneLine(thinking) || "(thinking)", sections: [{ label: "Thinking", body: thinking, format: "text" }] };
      return fallback("(no text content)", payload);
    }

    case "claude_tool_use": {
      const uses = toolUses(payload);
      if (uses.length === 0) return fallback("(tool use)", payload);
      return {
        summary: uses.map(u => {
          const arg = summarizeToolInput(u.name, u.input);
          return arg ? `${u.name} ${arg}` : u.name;
        }).join(" · "),
        sections: uses.map(u => ({ label: u.name, body: prettyJson(u.input), format: "code" })),
      };
    }

    case "claude_tool_result": {
      const results = toolResults(payload);
      if (results.length === 0) return fallback("(tool result)", payload);
      const joined = results.map(r => r.text).join("\n");
      const anyError = results.some(r => r.isError);
      return {
        summary: (anyError ? "⚠ " : "") + (oneLine(joined) || "(empty result)"),
        sections: results.map((r, i) => ({
          label: (results.length > 1 ? `Tool result ${i + 1}` : "Tool result") + (r.isError ? " (error)" : ""),
          body: r.text,
          format: "code",
        })),
      };
    }

    case "claude_system":
      return describeClaudeSystem(payload);

    case "report_submitted":
      return { summary: `📄 ${payload?.filename ?? "report"}`, sections: [payloadSection(payload)] };
    case "report_read": {
      const names = Array.isArray(payload?.filenames) ? payload.filenames : [];
      if (names.length > 0) {
        return { summary: `✓ read ${names.length} report${names.length === 1 ? "" : "s"}`, sections: [payloadSection(payload)] };
      }
      return { summary: `✓ read ${payload?.filename ?? ""}`.trimEnd(), sections: [payloadSection(payload)] };
    }
    case "report_unread":
      return { summary: `↺ unread ${payload?.filename ?? ""}`.trimEnd(), sections: [payloadSection(payload)] };
    case "escalation_requested":
      if (isNonEmptyString(payload?.command)) {
        return { summary: `🙋 approval: $ ${firstLine(payload.command)}`, sections: [payloadSection(payload)] };
      }
      return { summary: `🙋 ${payload?.filename ?? "needs input"}`, sections: [payloadSection(payload)] };
    case "escalation_resolved":
      if (isNonEmptyString(payload?.decision)) return describeCommandApprovalResolved(payload);
      return { summary: `✅ resolved ${payload?.filename ?? ""}`.trimEnd(), sections: [payloadSection(payload)] };
    case "feedback_received":
      return { summary: `✉ ${payload?.filename ?? "feedback"}`, sections: [payloadSection(payload)] };
    case "feedback_fetched": {
      const count = Number(payload?.count) || 0;
      return { summary: `${count} message${count === 1 ? "" : "s"} fetched`, sections: [payloadSection(payload)] };
    }

    case "action_invoked":
      return describeActionInvoked(payload);

    case "session_stopped": {
      const reason = payload?.reason;
      return { summary: reason ? `stopped (${reason})` : "stopped", sections: [payloadSection(payload)] };
    }
    case "session_crashed": {
      const parts = ["crashed"];
      if (Number.isFinite(payload?.exitCode)) parts.push(`(exit ${payload.exitCode})`);
      if (payload?.reason) parts.push(`— ${payload.reason}`);
      return { summary: parts.join(" "), sections: [payloadSection(payload)] };
    }

    default:
      return fallback(String(kind ?? "event"), payload);
  }
}

function describeClaudeSystem(payload) {
  if (typeof payload?.text === "string" && payload.type === "stderr") {
    return { summary: oneLine(payload.text) || "(empty stderr)", sections: [{ label: "stderr", body: payload.text, format: "code" }] };
  }
  if (typeof payload?.raw === "string" && payload.type === "raw") {
    return { summary: oneLine(payload.raw) || "(unparsed line)", sections: [{ label: "raw line", body: payload.raw, format: "code" }] };
  }
  if (payload?.type === "result") {
    const result = typeof payload.result === "string" ? payload.result : "";
    return {
      summary: `result${payload.is_error ? " (error)" : ""}${result ? `: ${oneLine(result)}` : ""}`,
      sections: result ? [{ label: "Result", body: result, format: "text" }, payloadSection(payload)] : [payloadSection(payload)],
    };
  }
  if (typeof payload?.subtype === "string") {
    return { summary: `system: ${payload.subtype}`, sections: [payloadSection(payload)] };
  }
  return fallback("system", payload);
}

function describeActionInvoked(payload) {
  const label = payload?.label ?? payload?.actionId ?? "action";
  const exit = Number.isFinite(payload?.exitCode) ? ` (exit ${payload.exitCode})` : "";
  const sections = [];
  if (isNonEmptyString(payload?.stdout)) sections.push({ label: "stdout", body: payload.stdout, format: "code" });
  if (isNonEmptyString(payload?.stderr)) sections.push({ label: "stderr", body: payload.stderr, format: "code" });
  if (isNonEmptyString(payload?.message)) sections.push({ label: "message", body: payload.message, format: "text" });
  return {
    summary: `${payload?.ok ? "✓" : "✗"} ${label}${exit}`,
    sections: sections.length > 0 ? sections : [payloadSection(payload)],
  };
}

// A command-approval escalation resolves into either "approved & ran" (with the
// command's exit code and captured output) or "rejected". Mirrors
// describeActionInvoked so the events stream shows the same result the agent
// received via its feedback inbox.
function describeCommandApprovalResolved(payload) {
  const approved = payload.decision === "approve";
  const exit = Number.isFinite(payload?.exitCode)
    ? ` (exit ${payload.exitCode})`
    : payload?.timedOut ? " (timed out)" : payload?.signal ? ` (${payload.signal})` : "";
  const cmd = isNonEmptyString(payload?.command) ? `: ${firstLine(payload.command)}` : "";
  const sections = [];
  if (isNonEmptyString(payload?.command)) sections.push({ label: "command", body: payload.command, format: "code" });
  if (isNonEmptyString(payload?.stdout)) sections.push({ label: "stdout", body: payload.stdout, format: "code" });
  if (isNonEmptyString(payload?.stderr)) sections.push({ label: "stderr", body: payload.stderr, format: "code" });
  return {
    summary: `${approved ? "✅ approved & ran" : "🚫 rejected"}${cmd}${approved ? exit : ""}`,
    sections: sections.length > 0 ? sections : [payloadSection(payload)],
  };
}

// ---- pure helpers --------------------------------------------------------

function fallback(summary, payload) {
  return { summary, sections: [payloadSection(payload)] };
}

function payloadSection(value) {
  return { label: "Payload", body: prettyJson(value), format: "code" };
}

function blocksOfType(payload, type) {
  const content = payload?.message?.content;
  return Array.isArray(content) ? content.filter(b => b && b.type === type) : [];
}

function assistantText(payload) {
  return blocksOfType(payload, "text").map(b => b.text).filter(t => typeof t === "string").join("\n").trim();
}

function toolUses(payload) {
  return blocksOfType(payload, "tool_use").map(b => ({
    name: typeof b.name === "string" ? b.name : "tool",
    input: b.input ?? {},
  }));
}

function toolResults(payload) {
  return blocksOfType(payload, "tool_result").map(b => ({ text: textFromContent(b.content), isError: b.is_error === true }));
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : prettyJson(part)))
      .join("\n");
  }
  return content == null ? "" : prettyJson(content);
}

// A short hint at the most identifying argument of a tool call (the file being
// read, the command being run, ...). Empty string when nothing fits, in which
// case the row shows the bare tool name and the full input lives in the panel.
function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object") return "";
  switch (name) {
    case "Bash": return isNonEmptyString(input.command) ? `$ ${firstLine(input.command)}` : "";
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write": return String(input.file_path ?? input.notebook_path ?? "");
    case "NotebookEdit": return String(input.notebook_path ?? "");
    case "Glob": return String(input.pattern ?? "");
    case "Grep": return isNonEmptyString(input.pattern) ? `/${input.pattern}/` : "";
    case "Task":
    case "Agent": return String(input.description ?? "");
    case "TodoWrite": return Array.isArray(input.todos) ? `(${input.todos.length} todos)` : "";
    case "WebFetch": return String(input.url ?? "");
    case "WebSearch": return String(input.query ?? "");
    default: return "";
  }
}

function oneLine(value, max = 140) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function firstLine(value) {
  return String(value ?? "").split("\n", 1)[0].trim();
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function prettyJson(value) {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}
