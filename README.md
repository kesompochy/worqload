# worqload

並走する claude セッションをブラウザから観測・介入する基盤。設計は [DESIGN.md](./DESIGN.md) を参照。

## Development

```sh
bun install
bun test
bun run dev          # `worqload serve` を --watch で起動
```

## CLI

```sh
worqload serve [port]                    # HTTP/WS server (default: 3456)
worqload init [path]                     # .worqload/ を初期化
worqload report submit --slug <slug>     # agent: report を提出 (本文は stdin)
worqload escalate submit --slug <slug>   # agent: 質問を提出 (本文は stdin)
worqload feedback fetch                  # agent: 未読 feedback を取得
```
