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

**1. Check principles and queue**
```sh
bun src/cli.ts heartbeat 300                     # record loop heartbeat (interval in seconds)
bun src/cli.ts principle
bun src/cli.ts list
```

If `waiting_human` tasks exist, present the question to the user and **stop the loop (CronDelete)**. Resume when the user responds.

**2. If queue has no pending tasks**

Observe the project state in light of the principles.
Propose what to do next and ask the user for approval:
```sh
bun src/cli.ts add "<proposed task>"
bun src/cli.ts observe <id> "<observations>"
bun src/cli.ts orient <id> "<analysis>"
bun src/cli.ts decide <id> --human "<proposal and question>"
```
This creates a `waiting_human` task, which stops the loop until the user responds.
Do NOT generate tasks and process them autonomously when the queue is empty.

**3. Process one task through OODA**
```sh
bun src/cli.ts next                              # pick next pending task
bun src/cli.ts source run                        # collect data from registered sources (includes feedback)
bun src/cli.ts feedback list                     # check for new feedback from external projects
bun src/cli.ts observe <id> "<what you found>"   # gather info
bun src/cli.ts orient <id> "<analysis>"          # analyze
bun src/cli.ts decide <id> "<plan>"              # decide action
bun src/cli.ts act <id>                          # start execution
# ... make code changes, run tests ...
bun src/cli.ts done <id> "<result>"              # mark complete
```

If a decision is difficult or architectural:
```sh
bun src/cli.ts decide <id> --human "<question>"
```

### Rules

- One task at a time. Finish or fail before starting the next.
- Small, incremental changes. Each task = one commit-sized unit of work.
- When uncertain, escalate with `--human`.
- After acting, verify with `bun test`.
- `principle` の追加・変更・削除はユーザーの明示的な指示がある場合のみ行う。Agentが独自判断で原則を操作してはならない。
