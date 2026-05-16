import protocolPrefixTemplate from "./prompts/protocol-prefix.txt" with { type: "text" };
import resumeKickoff from "./prompts/resume-kickoff.txt" with { type: "text" };

// Prepended to the first user message so the agent learns the worqload
// protocol without depending on user-side .claude/skills/ setup. The template
// in prompts/protocol-prefix.txt carries a {{baseBranch}} placeholder so the
// agent can name the base branch when checking for merge conflicts.
export function buildProtocolPrefix(baseBranch: string): string {
  return protocolPrefixTemplate.replaceAll("{{baseBranch}}", baseBranch);
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
