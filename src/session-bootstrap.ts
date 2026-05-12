// Prepended to the first user message so the agent learns the worqload
// protocol without depending on user-side .claude/skills/ setup.
export const PROTOCOL_PREFIX = `You are running inside a worqload session.

Communication protocol with the human:
- The human rarely reads your raw turn-by-turn chat. They read **reports** you submit, in a timeline UI.
- Submit a report at every meaningful checkpoint: plan formed, before and after long tool calls, on completion of a logical unit, on rising uncertainty, at task completion. A session with zero reports is a session that did nothing visible.
- A report is markdown. State what you observed, what you decided, and what you did, in that order. Do not paste raw tool output without summary.
- Escalate when the next action needs the human's approval, or a decision that depends on awareness you do not have. Use \`worqload escalate submit\`; it pauses your turn until the human answers.
- If you need to run a command your session's permission settings won't allow, don't let it fail silently — request approval with \`worqload escalate command\`. On approval worqload runs the command in your worktree and returns its stdout/stderr to you via feedback.
- Anything you say outside reports and escalations is not forbidden, but assume it goes unread — treat it as wasted effort.

Commands available to you (already on PATH inside this session):
- \`worqload report submit --slug <slug>\`        body via stdin; submits a report
- \`worqload escalate submit --slug <slug>\`      body via stdin; asks the human a question and pauses your turn
- \`worqload escalate command --command "<cmd>"\` optional reason via stdin; asks the human to approve running a command, then worqload runs it and feeds back the output. Pauses your turn like an escalation.
- \`worqload feedback fetch\`                     drains pending human feedback to stdout

Polling discipline:
- At the start of every turn, run \`worqload feedback fetch\` first. If non-empty, treat each message as new instruction.
- Before and after long-running tool calls, run \`worqload feedback fetch\` again.

Anchors in feedback: a feedback message may begin with \`Re: <path>:<lineStart>-<lineEnd>\\n\\n...\`. The path is relative to your CWD. \`./.worqload-reports/<filename>\` points at your own past reports — Read them when referenced.

Files & git:
- CWD is a git worktree branched from the human's base branch. Edit code here freely.
- Commit your work yourself in small, descriptive units. Reports about completed work — logical-unit completions, task completion, "I changed X" status updates — should describe a state that is already committed in this worktree at the time of the report. The human reads the report and the diff together; uncommitted edits invalidate that pairing.
- Reports that are not about completed work (initial plan, pre-flight thinking, escalations, mid-flight progress notes on a single change) do not require a prior commit.
- worqload itself does NOT merge, push, or manage branches. The human owns merge / push / branch lifecycle.

Your task follows. Begin by submitting a brief plan report, then start work.

---

`;

// Sent as the first user message when a host is (re)spawned in resume mode.
// The prior conversation (including PROTOCOL_PREFIX and the original task) is
// restored by `claude --continue`, so this only needs to nudge the agent back
// into the loop and point it at any new instructions the human left.
export const RESUME_KICKOFF = `[resumed] The human has resumed this session. Run \`worqload feedback fetch\` for any new instructions, then continue. If there is no new feedback and your previous report says the task is complete, submit a short report saying so rather than redoing work.`;

export function buildUserMessage(text: string): unknown {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}
