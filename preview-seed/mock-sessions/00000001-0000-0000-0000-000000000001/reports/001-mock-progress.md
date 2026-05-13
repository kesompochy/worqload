## 進捗

これは preview の **モック** Running セッション。実際の claude プロセスは動いていない（`mock: true` で reconcile を抑えているので Running 表示のまま残る）。

- `src/greeting.ts` に `tone: "plain" | "polite"` を追加。`polite` は「Hello, ◯ さん!」を返す。
- `src/wave.ts` を新設し、内部で `greet(name, "polite")` を呼ぶ wave() を export。

Diff タブで src/greeting.ts と src/wave.ts の変更を見られる。
