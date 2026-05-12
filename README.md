# worqload

A browser UI for observing and steering parallel `claude` sessions.

It narrows the human's role to Orient alone and raises its load average by running many sessions at once: each agent handles Observe / Decide / Act in its own worktree and pulls feedback when ready, while the human watches and replies asynchronously.

Reports, escalations, feedback, and the event log are all plain files on disk — worqload is a thin HTTP/WebSocket layer over them. Feedback can be anchored to a line range of either source code or a report. Merge, commit, and branch lifecycle stay out of scope.

## Development

```sh
bun install
bun test
bun run dev          # `worqload serve` under --watch
```

Run `worqload` with no arguments to list the CLI subcommands.
