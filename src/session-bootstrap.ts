import { join } from "node:path";
import protocolPrefixTemplate from "./prompts/protocol-prefix.txt" with { type: "text" };
import resumeKickoff from "./prompts/resume-kickoff.txt" with { type: "text" };

// The wq-issue-comment script ships inside the worqload install, not on PATH.
// A session's CWD is a worktree of whatever target repo worqload was started
// in, so the agent is handed the script's absolute path: a bare command would
// depend on `bun link` having been re-run, and a `bin/`-relative path would
// only resolve when the target repo happens to be worqload itself.
const defaultWqIssueCommentPath = join(import.meta.dir, "..", "bin", "wq-issue-comment");

// Prepended to the first user message so the agent learns the worqload
// protocol without depending on user-side .claude/skills/ setup. The template
// in prompts/protocol-prefix.txt carries a {{baseBranch}} placeholder so the
// agent can name the base branch when checking for merge conflicts, and a
// {{wqIssueComment}} placeholder for the absolute path of the wq-issue-comment
// script.
export function buildProtocolPrefix(
  baseBranch: string,
  wqIssueCommentPath: string = defaultWqIssueCommentPath,
): string {
  return protocolPrefixTemplate
    .replaceAll("{{baseBranch}}", baseBranch)
    .replaceAll("{{wqIssueComment}}", wqIssueCommentPath);
}

// Sent as the first user message when a host is (re)spawned in resume mode.
// The prior conversation (including the protocol prefix and the original task) is
// restored by `claude --continue`, so this only needs to nudge the agent back
// into the loop and point it at any new instructions the human left.
export const RESUME_KICKOFF = resumeKickoff;

export function buildUserMessage(text: string): unknown {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}
