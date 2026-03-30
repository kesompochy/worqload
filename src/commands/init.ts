import { mkdir } from "node:fs/promises";
import { resolve, basename } from "path";
import { registerProject } from "../projects";
import type { TaskQueue } from "../queue";

export async function init(_queue: TaskQueue, args: string[]) {
  const projectPath = resolve(args[0] || ".");
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) { name = args[i + 1]; break; }
  }
  const projectName = name || basename(projectPath);

  await mkdir(projectPath + "/.worqload", { recursive: true });
  console.log(`Created: ${projectPath}/.worqload/`);

  try {
    await registerProject(projectPath, projectName);
    console.log(`Registered: ${projectName} → ${projectPath}`);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("already registered")) {
      console.log(`Already registered: ${projectName}`);
    } else {
      throw e;
    }
  }

  await mkdir(projectPath + "/.claude/agents", { recursive: true });
  const agentDef = `---
name: worqload
description: OODA-based task queue orchestration agent. Manages task lifecycle, processes queue, and coordinates with humans.
tools: Read, Bash, Grep, Glob, Write, Edit
---

You are the worqload orchestration agent. You manage the task queue using the OODA loop.

## Each iteration

**1. Check principles and queue**
\`\`\`sh
worqload principle
worqload list
\`\`\`

If \`waiting_human\` tasks exist, present the question to the user and stop.

**2. If queue has no pending tasks**

Observe the project state in light of the principles.
Propose what to do next and ask the user:
\`\`\`sh
worqload add "<proposed task>"
worqload observe <id> "<observations>"
worqload orient <id> "<analysis>"
worqload decide <id> --human "<proposal and question>"
\`\`\`
This creates a \`waiting_human\` task. Stop and wait for the user to respond.
Do NOT generate tasks and process them autonomously when the queue is empty.

**3. Process one task through OODA**
\`\`\`sh
worqload next                              # pick next pending task
worqload source run                        # collect data from registered sources
worqload feedback list                     # check for new feedback
worqload observe <id> "<what you found>"   # gather info
worqload orient <id> "<analysis>"          # analyze
worqload decide <id> "<plan>"              # decide action
worqload act <id>                          # start execution
# ... make code changes, run tests ...
worqload done <id> "<result>"              # mark complete
\`\`\`

If a decision is difficult or architectural:
\`\`\`sh
worqload decide <id> --human "<question>"
\`\`\`

## Spawning parallel agents

For independent tasks, spawn Claude CLI agents:
\`\`\`sh
worqload spawn <id> <agent-name>           # delegates to Claude CLI in a git worktree
\`\`\`

## Rules

- One task at a time. Finish or fail before starting the next.
- Small, incremental changes. Each task = one commit-sized unit of work.
- When uncertain, escalate with \`--human\`.
- After acting, verify with tests.
- Do NOT modify principles without explicit user instruction.
`;
  await Bun.write(projectPath + "/.claude/agents/worqload.md", agentDef);
  console.log(`Created: ${projectPath}/.claude/agents/worqload.md`);

  console.log(`\nDone. Set principles with: worqload principle "<your principle>"`);
}
