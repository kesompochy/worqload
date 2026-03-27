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

If `waiting_human` tasks exist, present the question to the user and stop.

**2. Generate tasks if queue is empty**

Observe the project state in light of the principles.
Identify gaps and create tasks:
```sh
bun src/cli.ts add "<concrete task>"
```

**3. Process one task through OODA**
```sh
bun src/cli.ts next                              # pick next pending task
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
