# worqload

A browser UI for observing and steering parallel `claude` sessions.

## Development

```sh
bun test                   # run tests (pretest runs `vite build`)
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

- Prompts sent to `claude` live as plain `.txt` files under `src/prompts/`, loaded via Bun's `with { type: "text" }` import. Dynamic values use `{{placeholder}}` tokens substituted at build time.
- Asserting that a prompt contains a specific string is out of scope for automated tests. Prompt wording is tuned constantly; substring assertions only break on every reword without catching real regressions. Test the wiring (does the prompt reach the agent, is the placeholder substituted) — never the wording.
