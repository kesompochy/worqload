# worqload

A browser UI for observing and steering parallel `claude` sessions.

It narrows the human's role to Orient alone and raises its load average by running many sessions at once: the agents handle Observe / Decide / Act, the human watches and replies asynchronously. worqload stops at showing the diff — merge, commit, and branch lifecycle stay with the human.

## Development

```sh
bun install
bun test
bun run dev          # `worqload serve` under --watch
bun run preview      # try this checkout's UI against a throwaway ~/.worqload-preview repo (use from a worktree before merging)
```

Run `worqload` with no arguments to list the CLI subcommands.

Drop a `favicon.{svg,png,ico,jpg,gif,webp}` into a repo's `.worqload/` directory to override the browser-tab icon; without one, a built-in default is served.
