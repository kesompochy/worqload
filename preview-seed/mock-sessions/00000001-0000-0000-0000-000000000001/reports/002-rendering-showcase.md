## レンダリング記法サンプル

このレポートは各種マークダウン記法のプレビュー確認用。

### インライン記法

**太字**、*イタリック*、`インラインコード`、[通常リンク](https://example.com)。

リンク内にコードを含むパターン: [`src/greeting.ts` L5-12](https://example.com/greeting.ts#L5-L12)、[`wave()` を参照](https://example.com/wave.ts)。

ベアURL自動リンク: https://example.com/path/to/page

### コードブロック

```ts
export function greet(name: string, tone: "plain" | "polite" = "plain"): string {
  if (tone === "polite") return `Hello, ${name} さん!`;
  return `Hello, ${name}!`;
}
```

### リスト

- `src/greeting.ts` に `tone` 引数を追加
- `src/wave.ts` を新設
- **太字の項目** と `コード` を含むリスト

1. 最初のステップ
2. 次のステップ
3. 最後のステップ

### 引用

> これは引用ブロック。`コード` と **太字** を含む。

### テーブル

| ファイル | 変更内容 | 行数 |
| :--- | :---: | ---: |
| `greeting.ts` | tone引数追加 | +5 |
| `wave.ts` | 新規作成 | +8 |

---

水平線の上下にテキストがある状態。
