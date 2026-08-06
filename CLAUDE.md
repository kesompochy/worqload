# worqload

A browser UI for observing and steering parallel `claude` / `codex` sessions.

## Development

```sh
bun run test               # run all tests (small + medium)
bun run test:small         # unit tests only — no FS, process, or network deps (~2s)
bun run test:medium        # integration tests — git, servers, timers (~11s)
bun run dev                # vite build → serve with --watch
bun run preview            # vite build → run THIS checkout against a throwaway scratch repo (~/.worqload-preview)
bun run web:build          # build the browser frontend (web/ → web/dist/)
bun run web:watch          # rebuild the frontend on change (run alongside `worqload serve`)
worqload <command>         # CLI (built from src/cli.ts)
worqload serve --watch     # hot-reload run via `bun link` (sessions live in detached host processes, so a restart doesn't kill them)
```

The frontend is a Vite project under `web/` (plain ES modules + Svelte components). The server serves `web/dist/`. `worqload serve` builds it on first run if `web/dist/` is missing, but does not rebuild on edit, so run `bun run web:watch` alongside it.

## Conventions

- TDD: write the test before the implementation.
- Keep changes small. One task = one commit-sized unit.
- Reports written by worqload sessions are in Japanese.

## Prompts

- Prompts sent to agents are authored as plain `.txt` files under `src/prompts/`, with `{{placeholder}}` tokens for dynamic values. Add new prompts there rather than inlining them in code.
- Asserting that a prompt contains a specific string is out of scope for automated tests. Prompt wording is tuned constantly; substring assertions only break on every reword without catching real regressions. Test the wiring (does the prompt reach the agent, is the placeholder substituted) — never the wording.
