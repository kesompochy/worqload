# worqload

並走する claude セッションをブラウザから観測・介入する基盤。設計の詳細は `DESIGN.md` を参照。

## Development

```sh
bun test                   # run tests
bun run dev                # serve with --watch
worqload <command>         # CLI (built from src/cli.ts)
worqload serve --watch     # bun link 経由でホットリロード起動 (セッションは detached host 側に残るので restart で死なない)
```

## Conventions

- TDD: 実装より先にテストを書く。
- 変更は小さな単位で。1 タスク = 1 commit-sized unit。
- worqload セッションが書く report は日本語。
