# worqload

並走する claude セッションをブラウザから観測・介入する基盤。

## Development

```sh
bun test                   # run tests (pretest runs `vite build`)
bun run dev                # vite build → serve with --watch
bun run web:build          # build the browser frontend (web/ → web/dist/)
bun run web:watch          # rebuild the frontend on change (run alongside `worqload serve`)
worqload <command>         # CLI (built from src/cli.ts)
worqload serve --watch     # bun link 経由でホットリロード起動 (セッションは detached host 側に残るので restart で死なない)
```

フロントエンドは `web/` の Vite プロジェクト（素の ES モジュール + Svelte コンポーネント）。サーバは `web/dist/` を配信する。`worqload serve` は `web/dist/` が無ければ初回に自動ビルドするが、編集後の再ビルドはしないので `bun run web:watch` を併走させる。

## Conventions

- TDD: 実装より先にテストを書く。
- 変更は小さな単位で。1 タスク = 1 commit-sized unit。
- worqload セッションが書く report は日本語。
