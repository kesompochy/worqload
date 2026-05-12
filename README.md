# worqload

A browser UI for observing and intervening in parallel `claude` sessions.

worqload narrows the human's role down to Orient alone, and then raises the density of that work — the load average of the human's labor — by keeping many sessions in flight at once. Each agent runs Observe / Decide / Act on its own and escalates the moment something needs human judgment; the human moves between sessions answering those escalations and steering, and does nothing a machine could have done.

One task = one session = one child `claude` process; the three concepts line up 1:1:1. Communication is asynchronous and pull-based: the agent submits reports and escalations on its own cadence and fetches feedback when it is ready, instead of the runtime pushing messages into its stdin.

Everything exchanged between human and agent — reports, escalations, feedback, the event log — is plain files (Markdown / NDJSON) on disk; worqload is a thin HTTP/WebSocket layer over them. Feedback can be anchored to a line range, and the same primitive (file path + line range) addresses both source code and the agent's own reports. worqload is tightly coupled to the git worktree and the diff view only — merge, commit, and branch lifecycle are out of scope and remain the human's responsibility.

## Development

```sh
bun install
bun test
bun run dev          # `worqload serve` under --watch
```

Run `worqload` with no arguments to list the CLI subcommands.
