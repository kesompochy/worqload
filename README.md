# worqload

A browser UI for observing and steering parallel `claude` / `codex` sessions.

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

## Report polishing

A report a claude session submits is not stored as written. worqload resumes the session's own conversation as a fork (`claude -p --resume <id> --fork-session`, same model, same worktree) and has the fork list the report-writing rules it was given, mark each sentence that breaks one, and rewrite the report — twice at most. The human sees only the rewritten report. The session gets the stored text in its feedback inbox when it differs from the draft. codex and cursor sessions store reports as submitted.
