# worqload

AI Agent用のタスクキュー。OODAループでタスクのライフサイクルを管理する。

## Development

```sh
bun src/cli.ts <command>   # CLI (development)
bun test                   # test
```

## Autonomous Workflow

You are the orchestration agent. Your job is to increase the load average of productive work.
Use `/loop` to keep this cycle running.

### Each iteration:

**1. Pre-checks**
```sh
worqload sleep                             # check if paused
worqload heartbeat 300                     # record loop heartbeat (interval in seconds)
worqload spawn-cleanup                     # recover stuck spawns
```

If the loop is sleeping, **silently skip to the next iteration** — produce no chat output at all.

**2. Observe**

```sh
worqload iterate                           # collect all observations and run OODA cycle
```

`iterate` internally collects Principles, feedback, sources, tasks, missions, and server logs via `collectObservation()`. The output includes principle items, feedback counts/themes, and all other observation data. No separate commands needed.

**3. Orient**

Compare observations against Principles. Every decision must trace back to a Principle.
- If Principles are sufficient to determine the action → proceed to Decide
- If Principles are insufficient → escalate: `worqload orient <id> --human "<question>"`
- Feedback from humans is their Orient output. Read it, understand it, act on it.

**4. Decide & Act**

Based on the `iterate` output:
- **waiting_human**: questions are visible on the dashboard (web UI). Do not duplicate them in chat output. Skip to next iteration.
- **tasks_created**: iterate auto-generated tasks from observations. Assign them to missions.
- **mission_run**: start mission runners for listed missions
- **unassigned**: assign tasks to an appropriate mission, then start runners
- **tasks in progress**: audit progress (see below)

Start mission runners via Agent tool (NOT Bash background):
```
Use the Agent tool to run `worqload mission run <mission-id>`.
```
Mission runners spawn `claude` subprocesses that may run for minutes.
Running them via Bash `run_in_background` causes the parent process to die
before the spawn completes. The Agent tool maintains proper parent-child
process lifecycle.

Assign unassigned tasks:
```sh
worqload mission assign <mission-id> <task-id>
```

**5. Audit**

After delegating to mission runners, the main session must verify progress:
```sh
worqload list                              # check task states
worqload show <task-id>                    # inspect task logs for substance
worqload feedback summary                  # check for new human input
```

- Tasks stuck in one phase for multiple iterations → investigate
- Tasks marked done without act logs or reports → flag as suspicious
- Mission runner processes that died → restart via `worqload mission run`
- New feedback arrived → Orient against Principles and create tasks

### Rules

- Delegate task execution to mission runners. The main loop manages the queue, not the work itself. This includes reports — spawned agents write reports, not the main session.
- Small, incremental changes. Each task = one commit-sized unit of work.
- Write tests before implementation (TDD).
- Reports must be written in Japanese.
- When uncertain during Orient, escalate with `worqload orient <id> --human`. Only the main session may use `--human`; spawned agents that need escalation must exit with code 3 (ESCALATION_EXIT_CODE) so the mission runner promotes the task to waiting_human.
- Run independent missions in parallel when possible.
- `principle` の追加・変更・削除はユーザーの明示的な指示がある場合のみ行う。Agentが独自判断で原則を操作してはならない。
- Feedback is human input. Agents never create feedback — they create tasks and reports.
- Minimal output: Only produce chat output for audit findings or new feedback to present. `waiting_human` questions are surfaced via the dashboard, not chat. If all tasks are being handled and there is nothing new, produce NO output.
