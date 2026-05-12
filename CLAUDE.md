# worqload

A browser UI for observing and steering parallel `claude` sessions.

## Development

```sh
bun test                   # run tests (pretest runs `vite build`)
bun run dev                # vite build → serve with --watch
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
