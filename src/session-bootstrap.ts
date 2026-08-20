import { join } from "node:path";
import protocolPrefixTemplate from "./prompts/protocol-prefix.txt" with { type: "text" };
import resumeKickoff from "./prompts/resume-kickoff.txt" with { type: "text" };
import turnWithoutReportNudge from "./prompts/turn-without-report-nudge.txt" with { type: "text" };
import { defaultConfigPath, loadProtocolPrefix } from "./textlint";

const defaultWqIssueCommentPath = join(import.meta.dir, "..", "bin", "wq-issue-comment");

export async function buildProtocolPrefix(
  baseBranch: string,
  wqIssueCommentPath: string = defaultWqIssueCommentPath,
  configPath: string = defaultConfigPath(),
): Promise<string> {
  const customPrefix = (await loadProtocolPrefix(configPath)) ?? "";
  return protocolPrefixTemplate
    .replaceAll("{{custom-protocol-prefix}}", customPrefix)
    .replaceAll("{{baseBranch}}", baseBranch)
    .replaceAll("{{wqIssueComment}}", wqIssueCommentPath);
}

// Sent as the first user message when a host is (re)spawned in resume mode.
// The prior conversation (including the protocol prefix and the original task) is
// restored by `claude --continue`, so this only needs to nudge the agent back
// into the loop and point it at any new instructions the human left.
export const RESUME_KICKOFF = resumeKickoff;

// Sent to the agent when a turn ends without a Report or Escalation. The human
// reads the session through those two channels, so a silent turn-end leaves
// them blind; this nudges the agent to report (or escalate) before going idle.
export const TURN_WITHOUT_REPORT_NUDGE = turnWithoutReportNudge;

export function buildUserMessage(text: string): unknown {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}
