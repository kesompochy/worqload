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

**1. Pre-checks**
```sh
bun src/cli.ts sleep                             # check if paused
bun src/cli.ts heartbeat 300                     # record loop heartbeat (interval in seconds)
bun src/cli.ts spawn-cleanup                     # recover stuck spawns
```

If the loop is sleeping, **silently skip to the next iteration** — produce no chat output at all.

**2. Run managed iteration**
```sh
bun src/cli.ts iterate
```

`iterate` creates a tracked OODA task that:
- **Observe**: collects feedback summary, source data, missions, principles, task list
- **Orient**: analyzes queue state (queue_empty / waiting_human / has_pending)
- **Decide**: determines action based on analysis
- **Act**: outputs the decision and marks the iteration done

The output tells you what to do next:
- **waiting_human**: present the listed questions to the user, skip to next iteration
- **queue empty**: propose next action to the user via `add` + `decide --human`
- **pending tasks**: spawn agents to process them

**3. Act on the iteration result**

If `iterate` reports pending tasks, spawn them:
```sh
bun src/cli.ts spawn <id> <command...>
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
