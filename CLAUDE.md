# worqload

A browser UI for observing and steering parallel `claude` / `codex` sessions.

## Development

```sh
bun run test               # run all tests (small + medium)
bun run test:small         # unit tests only — no FS, process, or network deps (~2s)
bun run test:medium        # integration tests — git, servers, timers (~20s)
bun run dev                # vite build → serve with --watch
bun run preview            # vite build → run THIS checkout against a throwaway scratch repo (~/.worqload-preview)
bun run web:build          # build the browser frontend (web/ → web/dist/)
bun run web:watch          # rebuild the frontend on change (run alongside `worqload serve`)
worqload <command>         # CLI (built from src/cli.ts)
worqload serve --watch     # hot-reload run via `bun link` (sessions live in detached host processes, so a restart doesn't kill them)
```

The frontend is a Vite project under `web/` (plain ES modules + Svelte components). The server serves `web/dist/`. `worqload serve` builds it on first run if `web/dist/` is missing, but does not rebuild on edit, so run `bun run web:watch` alongside it.

## Tests

- The file name decides the suite: `*.small.test.ts` is small, every other `*.test.ts` under `src/` and `web/` is medium.
- Small: tests with no FS, process, or network dependencies. They all run in a single `bun test` process.
- Medium: the default, for tests that touch the filesystem, real `git`, servers, child processes, or timers. `scripts/test-files.ts` runs each file in its own `bun test` process, several at a time, and kills a file that runs longer than 60s.
- Run tests when the change calls for it, not after every edit. Running the files that cover the change with `bun test <file>` is usually enough; run `bun run test` when the change can affect other areas.

## Conventions

- TDD: write the test before the implementation.
- Keep changes small. One task = one commit-sized unit.
- Reports written by worqload sessions are in Japanese.
- Do not use the browser's native dialogs (`confirm()`, `alert()`, `prompt()`) in the frontend. Build confirmation and input into the page itself, e.g. the inline confirm button of report reject in `web/svelte/DetailBody.svelte`.

## Operations

### Archive backup

セッションのレポート・フィードバックは `~/.local/share/worqload/archive.db`（SQLite、WAL モード）に蓄積される。Google Drive へのバックアップ手順:

```sh
# 前提: gcloud がインストール済みであること
# 前提: gws (Google Workspace CLI) がインストール済みであること — brew install googleworkspace-cli

# 初回のみ: Drive スコープを有効にして gcloud 認証
gcloud auth login --enable-gdrive-access

# バックアップ実行
worqload archive-backup /tmp/worqload-archive.db
GOOGLE_WORKSPACE_CLI_TOKEN=$(gcloud auth print-access-token) gws drive +upload /tmp/worqload-archive.db --name "worqload-archive.db"
rm /tmp/worqload-archive.db
```

`archive-backup` は `VACUUM INTO` で整合性のあるスナップショットを作成する。`gws` は gcloud のファーストパーティ OAuth トークンを使うため、サードパーティへの権限委譲や GCP プロジェクトの新規作成は不要。

## Prompts

- Prompts sent to agents are authored as plain `.txt` files under `src/prompts/`, with `{{placeholder}}` tokens for dynamic values. Add new prompts there rather than inlining them in code.
- worqload is OSS used by people with different tastes. Keep in its prompts only what every user needs: procedures (how to polish, how to submit) and the protocol worqload itself runs on. What makes a report good — which sentences to cut, tone, wording norms — is one user's taste: leave it to what the user and project give (their CLAUDE.md, the `protocolPrefix` and other config, feedback), and when worqload must act on it, make it pluggable through config rather than writing it into `src/prompts/`.
- Asserting that a prompt contains a specific string is out of scope for automated tests. Prompt wording is tuned constantly; substring assertions only break on every reword without catching real regressions. Test the wiring (does the prompt reach the agent, is the placeholder substituted) — never the wording.
