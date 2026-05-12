# フロントエンド Svelte 移行 — 残作業

`web/` の素の JS による手動 DOM 構築（`render.js` の `innerHTML` 全再構築 + リスナ再バインド + スクロール/入力値の手動退避）を Svelte 5 コンポーネントへ段階移行している途中。このファイルは引き継ぎ用のメモ。

## 済み

- Vite ビルド導入（`vite.config.ts`、`root: "web"`、`@sveltejs/vite-plugin-svelte`）。成果物は `web/dist/`、`web-server.ts` が `/` → `web/dist/index.html`、`/assets/*` → `web/dist/assets/*` を配信。`worqload serve` は `web/dist` が無ければ初回に自動ビルド（`src/web-build.ts: buildWebFrontend()`）。`worqload serve --watch` は `vite build --watch`（`watchWebFrontend()`）を外側プロセスで併走（ブラウザのリロードは手動）。
- 新規セッションモーダル → `web/svelte/NewSessionModal.svelte`（`main.ts` が `document.body` にマウント、`#btnNew` の click で `open()`）。
- 共有ビュー状態を `web/state.svelte.js` に移し `$state(...)` でラップ（リアクティブ）。まだ vanilla の `api.js` / `handlers.js` がそのまま読み書きしている。
- サイドバーのセッション一覧 → `web/svelte/SessionList.svelte`（`main.ts` が `#sessionList` にマウント）。`render.js` の `renderSessionList()` は no-op stub として残置（`api.js` / `handlers.js` が「セッション変わった」シグナルとして呼び続ける。`state` は既に更新済みなのでやることが無い）。

## 残り（おおむねこの順で、各々 1〜数コミット）

`render.js` の `renderDetail()`（詳細ペイン全体を `#detail` に innerHTML で構築している巨大関数）を解体して Svelte 化する。サブ領域ごとに分けられる:

1. **詳細ヘッダ + メタ + タブバー**（`#detail` 上部、`detail-header` / `detail-meta` / `.tabs`）。`switchTab` は `state.activeTab` を変えるだけにできる。
2. **Reports タブ** + **Feedback sent** セクション（`state.reports` / `state.feedbackHistory`、`isReportExpanded` / `isFeedbackExpanded`、`onReportMark` などのトグル）。
3. **Diff タブ** — `web/diff-view.js` の `renderDiffHtml()` / `parseDiffFiles` / `mergeLineRanges` / `renderDiffHtml` を Svelte コンポーネント化。`src/diff-view.test.ts` が `renderDiffHtml` を文字列で検証しているので、コンポーネント化したらこのテストを書き直す（`parseDiffFiles` / `mergeLineRanges` は純粋関数なので残せる）。`onExpandAllDiffFiles` / `onCollapseAllDiffFiles` / `expandDiffGap` / 行クリックでアンカー（`onLineClick`）。
4. **Files タブ** — `web/files-view.js` の `renderFilesHtml()` / `buildFileTree`。`src/files-view.test.ts` 同様。`selectFile`、ディレクトリ折りたたみ。
5. **Events タブ** — `web/events-view.js` の `renderEventsHtml()` / `describeEvent`（`describeEvent` は純粋、`src/events-view.test.ts` で検証中なので残す）。`refreshEventsTabLabel`（1秒ごとに Events タブの「Ns ago」を更新）はコンポーネント内の `$effect` + `setInterval` か、`$derived` + 別の時刻 `$state` で置換できる。
6. **action bar + action panel** — `web/actions-view.js` の `renderActionPanelHtml()`、`toggleActionPanel` / `runOpenAction` / `onResolveCommand`。
7. **composer フォーム**（feedback / resume、`anchor-chip`、IME ガード付き Enter 送信）。`bindEnterToSubmit` / `onFeedback` / `onResume` / `clearAnchor`。
8. **asking セクション**（保留中のエスカレ回答 UI、`onResolve`）。
9. 上記が全部 Svelte 化できたら **`render.js` 全体を削除**し、`api.js` / `handlers.js` から `renderDetail` / `renderSessionList` の呼び出しを除去（`state` 更新だけにする）。`renderDetail` がやっていたスクロール位置の退避・復元のハックは、Svelte が DOM を破棄しない（keyed each、`{#if}` の安定性）ので大部分が不要になるはず。`captureDetailScroll` / `restoreDetailScroll` / `state.tabScroll` の必要性を再評価。
10. `main.ts` を整理（最終的には `import "./app.js"` を解体し、`app.js` の初期 fetch / 30秒ポーリング / 1秒ティックを Svelte 側（ルートコンポーネントの `onMount` / `$effect`）へ移す）。`index.html` のシェルも最小化（`#detail` / `#sessionList` / `#toast` の素の div は最終的に Svelte ルートに置換可能）。

## 注意点 / 落とし穴

- **`$state` と命名衝突**: コンポーネント内で `import { state } from "../state.svelte.js"` のように `state` という名前の束縛を作ると、Svelte が `$state` をストア購読（`$`+変数名）と解釈してビルドエラー（`store_rune_conflict`）。`import { state as appState }` のように別名にする（`SessionList.svelte` がそうしている）。
- **`bun test` と runes**: `bun test` は `.svelte.js` を Svelte コンパイラ無しで読むので `$state` 等が未定義になる。`bunfig.toml` の `preload`（`src/svelte-runes-test-shim.ts`）が `globalThis.$state` を恒等関数として定義している。`.svelte.js` で `$derived` / `$effect` 等を新しく使ったら、このシムにも足す（テストがその関数を読むなら）。`.svelte` ファイル自体は `bun test` から直接読まれない（ビルドは `web-bundle.test.ts` が Vite 経由で行う）ので問題ない。
- **`vite build` CLI は `--config ./vite.config.ts` 必須**: vite@8（rolldown-vite）では、リポジトリ直下から `vite build`（`--config` 無し）を実行すると `root: "web"` 指定との相互作用で svelte プラグインが効かず `.svelte` が生のままバンドルされてパースエラーになる。`--config ./vite.config.ts` を付けると直る。`package.json` の `web:build` / `web:watch` / `dev` / `pretest` は全部付けてある。プログラム的ビルド（`src/web-build.ts`）は元から `configFile` 明示なので影響なし。
- **a11y 警告**: `<div onclick=...>` は Svelte が a11y 警告を出す。`<!-- svelte-ignore ... -->` が効かなかったので `SessionList.svelte` のカードは `role="button" tabindex="0" onkeydown`（Enter/Space で選択）にした。新しくクリック可能 div を作るときは同様にするか、最初から `<button>` を使う。
- **`renderSessionList()` / `renderDetail()` の no-op stub パターン**: 段階移行中は、Svelte 化した領域に対応する `render.js` の関数を空の stub にして、`api.js` / `handlers.js` の呼び出しはそのまま残す（呼び出し側は `state` を更新してから stub を呼ぶ → リアクティブに再描画される）。全部移行し終わってから呼び出しを掃除する。
- **`web/svelte.config.js`**: `vitePreprocess()` のみ。これが無いと「no Svelte config found」警告が毎ビルド出る。`<script lang="ts">` を使いたくなったら preprocess が効く。
- **コミットメッセージ**: `bash-write-guard` フック（`~/.claude/hooks/bash-write-guard.sh`）が `git commit -F-` のヒアドキュメント本文もスキャンするので、`op ` `make ` `bun add ` 等の文字列が本文に入るとブロックされる。短い `-m` メッセージか、トリガー語を避けた本文で。
- **rebase 運用**: main が並行セッションでよく進む。本ブランチは何度か `git rebase main` 済み（main は `Merge session 5694b489` で本ブランチの一部を既に取り込み済み）。push されていないので rebase で問題ない。

## 動作確認

- `bun test`（全テスト、`web-bundle.test.ts` が Vite 本番ビルドを実行する安全網）。
- `bun run web:build` でビルドが通ること、`worqload serve --watch` で起動してブラウザで触ること（ヘッドレス手段が無いので手動）。
