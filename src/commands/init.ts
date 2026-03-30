import { mkdir } from "node:fs/promises";
import { resolve, basename, dirname } from "path";
import { registerProject } from "../projects";
import { loadConfig } from "../config";
import type { TaskQueue } from "../queue";
import { parseFlags } from "../utils/args";

const DEFAULT_AGENT_PATH = ".claude/agents/worqload.md";

const DEFAULT_AGENT_TEMPLATE = `---
name: worqload
description: OODA-based task queue orchestration agent. Manages task lifecycle, processes queue, and coordinates with humans.
tools: Read, Bash, Grep, Glob, Write, Edit
---

You are the worqload orchestration agent. You manage the task queue using the OODA loop.

## Each iteration

**1. Check principles and queue**
\\\`\\\`\\\`sh
worqload principle
worqload list
\\\`\\\`\\\`

If \\\`waiting_human\\\` tasks exist, present the question to the user and stop.

**2. If queue has no pending tasks**

Observe the project state in light of the principles.
Propose what to do next and ask the user:
\\\`\\\`\\\`sh
worqload add "<proposed task>"
worqload observe <id> "<observations>"
worqload orient <id> "<analysis>"
worqload decide <id> --human "<proposal and question>"
\\\`\\\`\\\`
This creates a \\\`waiting_human\\\` task. Stop and wait for the user to respond.
Do NOT generate tasks and process them autonomously when the queue is empty.

**3. Process one task through OODA**
\\\`\\\`\\\`sh
worqload next                              # pick next pending task
worqload source run                        # collect data from registered sources
worqload feedback list                     # check for new feedback
worqload observe <id> "<what you found>"   # gather info
worqload orient <id> "<analysis>"          # analyze
worqload decide <id> "<plan>"              # decide action
worqload act <id>                          # start execution
# ... make code changes, run tests ...
worqload done <id> "<result>"              # mark complete
\\\`\\\`\\\`

If a decision is difficult or architectural:
\\\`\\\`\\\`sh
worqload decide <id> --human "<question>"
\\\`\\\`\\\`

## Spawning parallel agents

For independent tasks, spawn processes:
\\\`\\\`\\\`sh
worqload spawn <id> <command...>
\\\`\\\`\\\`

## Rules

- One task at a time. Finish or fail before starting the next.
- Small, incremental changes. Each task = one commit-sized unit of work.
- When uncertain, escalate with \\\`--human\\\`.
- After acting, verify with tests.
- Do NOT modify principles without explicit user instruction.
`;

export async function init(_queue: TaskQueue, args: string[]) {
  const { flags, rest } = parseFlags(args, ["--name"]);
  const projectPath = resolve(rest[0] || ".");
  const projectName = flags["--name"] || basename(projectPath);

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

  const configPath = projectPath + "/.worqload/config.json";
  const configFile = Bun.file(configPath);
  if (!(await configFile.exists())) {
    const isGit = await Bun.file(projectPath + "/.git/HEAD").exists();
    const defaultConfig = isGit ? {
      spawn: {
        pre: [
          "branch=worqload/$WORQLOAD_TASK_ID && dir=.worqload/worktrees/$WORQLOAD_TASK_ID && git worktree add -b $branch $dir 2>/dev/null && echo WORQLOAD_SPAWN_CWD=$dir"
        ],
        post: [
          "[ \"$WORQLOAD_SPAWN_EXIT_CODE\" = \"0\" ] && [ -n \"$WORQLOAD_SPAWN_CWD\" ] && git merge worqload/$WORQLOAD_TASK_ID --no-edit 2>&1 || true"
        ]
      }
    } : {};
    await Bun.write(configPath, JSON.stringify(defaultConfig, null, 2));
    console.log(`Created: ${configPath}${isGit ? " (with worktree hooks)" : ""}`);
  }

  const config = await loadConfig(configPath);
  const agentPath = projectPath + "/" + (config.init?.agentPath || DEFAULT_AGENT_PATH);
  const agentTemplate = config.init?.agentTemplate
    ? await Bun.file(config.init.agentTemplate).text()
    : DEFAULT_AGENT_TEMPLATE;

  await mkdir(dirname(agentPath), { recursive: true });
  await Bun.write(agentPath, agentTemplate);
  console.log(`Created: ${agentPath}`);

  console.log(`\nDone. Set principles with: worqload principle "<your principle>"`);
}
