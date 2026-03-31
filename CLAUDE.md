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
- **queue empty**: propose next action to the user via `add` + `orient --human`
- **mission_run**: start mission runners for listed missions
- **unassigned**: tasks need a mission assignment before processing

**3. Act on the iteration result**

If `iterate` reports missions to run, start mission runners:
```sh
bun src/cli.ts mission run <mission-id>
```

Mission runners are the **sole mechanism for task processing**. Do not use `spawn` to process individual tasks — always delegate to `mission run`. Each mission runner:
- Picks the next unclaimed task by priority
- Runs it through the full OODA loop (observe → orient → decide → act)
- Auto-retries failed tasks (up to 2 attempts)
- Auto-completes the mission when all tasks reach a terminal state
- Stays alive for 30 minutes of idle before exiting

Start one runner per mission. Multiple mission runners can run in parallel.

If there are unassigned tasks, assign them to an appropriate mission first:
```sh
bun src/cli.ts mission assign <mission-id> <task-id>
```

If a decision is difficult or architectural, escalate during orientation:
```sh
bun src/cli.ts orient <id> --human "<question>"
```

### Rules

- Delegate task execution to mission runners. The main loop manages the queue, not the work itself.
- Small, incremental changes. Each task = one commit-sized unit of work.
- Write tests before implementation (TDD).
- Reports must be written in Japanese.
- When uncertain, escalate with `--human`.
- Run independent missions in parallel when possible.
- `principle` の追加・変更・削除はユーザーの明示的な指示がある場合のみ行う。Agentが独自判断で原則を操作してはならない。
- Minimal output: Only produce chat output when there is something actionable for the human — a `waiting_human` question or an empty-queue proposal. If all tasks are being handled by mission runners and there is nothing new, produce NO output.
