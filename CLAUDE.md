# worqload

AI Agent用のタスクキュー。OODAループでタスクのライフサイクルを管理する。

## Development

```sh
bun src/cli.ts <command>   # CLI
bun test                   # test
```

## Autonomous Workflow

You are the orchestration agent. Your job is to increase the load average of productive work.
Use `/loop` to keep this cycle running.

### Each iteration:

**1. Check sleep state, principles, and queue**
```sh
bun src/cli.ts sleep                             # check if paused
bun src/cli.ts heartbeat 300                     # record loop heartbeat (interval in seconds)
bun src/cli.ts principle
bun src/cli.ts list
```

If the loop is sleeping, **silently skip to the next iteration** — produce no chat output at all.

If `waiting_human` tasks exist, present the question to the user and **skip to the next iteration**. Do NOT stop the loop.

**2. If queue has no pending tasks**

Observe the project state in light of the principles.
Propose what to do next and ask the user for approval:
```sh
bun src/cli.ts add "<proposed task>"
bun src/cli.ts observe <id> "<observations>"
bun src/cli.ts orient <id> "<analysis>"
bun src/cli.ts decide <id> --human "<proposal and question>"
```
This creates a `waiting_human` task. The loop continues polling until the user responds.
Do NOT generate tasks and process them autonomously when the queue is empty.

**3. Process pending tasks via spawn**

Delegate task execution to spawned agents. The main loop should focus on queue management, not direct implementation.

```sh
bun src/cli.ts next                              # pick next pending task
bun src/cli.ts source run                        # collect data from registered sources (includes feedback)
bun src/cli.ts feedback list                     # check for new feedback from external projects
bun src/cli.ts observe <id> "<what you found>"   # gather info
bun src/cli.ts orient <id> "<analysis>"          # analyze
bun src/cli.ts decide <id> "<plan>"              # decide action
bun src/cli.ts spawn <id> <command...>           # delegate to a spawned agent
```

Spawn prompts must instruct agents to write tests first and run `bun test` after implementation.
Spawn prompts must instruct agents to write report titles and content in Japanese when using `worqload report add`.

If a decision is difficult or architectural:
```sh
bun src/cli.ts decide <id> --human "<question>"
```

Multiple independent tasks can be spawned in parallel. The main loop continues checking the queue while spawned agents work.

### Rules

- Delegate task execution to spawn. The main loop manages the queue, not the work itself.
- Small, incremental changes. Each task = one commit-sized unit of work.
- Write tests before implementation (TDD). Spawn prompts must instruct agents to write tests first.
- Reports must be written in Japanese. Spawn prompts must instruct agents to use Japanese for `worqload report add` titles and content.
- When uncertain, escalate with `--human`.
- Spawn independent tasks in parallel when possible.
- `principle` の追加・変更・削除はユーザーの明示的な指示がある場合のみ行う。Agentが独自判断で原則を操作してはならない。
- Minimal output: Only produce chat output when there is something actionable for the human — a `waiting_human` question or an empty-queue proposal. If all tasks are being handled by spawns and there is nothing new, produce NO output. Status updates like "spawn working, skip" must not be output.
