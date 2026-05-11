# worqload 再設計

このドキュメントは、現行 worqload (OODA タスクキュー / mission orchestrator) を、「並走する claude セッションをブラウザから観測・介入する基盤」へ作り変えるための設計書である。現行実装を置き換えることを前提とする。

---

## 0. 背景

現行 worqload は AI agent 向けの OODA ループ式タスクキューとして設計された。実運用後の観察:

- **Orient (状況判断) は人間の役割**。Principles で代替する射程は実用に足りなかった。
- **キューが意味を持つのは「Orient を AI が自走できる」前提下のみ**。Orient が人間に戻るとキューはほぼ FIFO 以上の働きをしない。
- **エスカレーション内容をブラウザで読める体験は機能していた**。
- **生ログを人間は読みたくない**。整形された report が会話の主経路になるべき。

結論: queue / autonomy 向きの装置を剥がし、worqload を「並走する claude セッションを観測・介入する browser UI」として再構築する。

---

## 1. 設計思想

- **1 task = 1 session = 1 child process**: 概念を 1:1:1 で揃える。
- **Orient は人間に置く**: agent は O / D / A を担当し、判断ポイントで人間にエスカレートする。
- **非同期通信は pull**: feedback は agent が自分のタイミングで取りに行く。runtime が stdin に流し込まない。
- **ファイル中心**: report / escalation / feedback / event はすべてファイル (NDJSON / Markdown) として表現される。worqload はその上の薄い API レイヤ。
- **行アンカー付き feedback**: ソースコードの行にも report の行にも、同じ primitive (file path + 行範囲) で意見できる。
- **git は diff と worktree にだけ密結合**: merge / commit / branch lifecycle はスコープ外。worqload は「diff を見せる」までで止まる。

---

## 2. アーキテクチャ

- バックエンド: Bun + TypeScript。HTTP + WebSocket server。
- 子プロセス: `claude --input-format stream-json --output-format stream-json` を session ごとに 1 つ spawn。
- 永続化: ファイルシステムのみ (NDJSON event log + Markdown / JSON ファイル)。DB なし。
- フロントエンド: SPA (技術選定は実装フェーズで決める)。コードビューア相当のコンポーネントが必要 (Monaco / CodeMirror など)。
- 通信: WebSocket (live event 配信)、REST (action)。

---

## 3. ファイルレイアウト

```
<main repo>/
  .worqload/
    config.json
    sessions/
      <sessionId>/
        meta.json                # title, prompt, baseBranch, baseCommit, status, pid, createdAt, endedAt
        events.ndjson            # append-only event log
        reports/                 # agent → human の発話
          001-plan.md
          002-build-failed.md
          ...
        asking/                  # escalation 待機中
          001-which-lib.md
          resolved/              # 解決済み escalation
            001-which-lib.md
        feedback/
          inbox/                 # 未読 (human → agent)
            001-fix-typo.md
            ...
          read/                  # 既読
            001-fix-typo.md
  .worktrees/
    <sessionId>/                 # agent の CWD
      .worqload-reports          # symlink → ../../.worqload/sessions/<id>/reports/
      ... (チェックアウトされたコード)
```

注:

- `.worqload/` は本体 repo に置く。worktree 側ではない (per-session メタデータは worktree のライフサイクルとは独立に保持する)。
- `.worqload-reports` symlink は agent が「自分が書いた report の特定行」を読み返すために必要 (feedback `Re: ./.worqload-reports/<file>:<lines>` への対応)。
- `.worqload-feedback` symlink は不要。feedback 取得は `worqload feedback fetch` 経由。
- `.worqload/` および `.worqload-reports` の `.gitignore` 登録は worqload では自動化しない。利用者が手動で行う。

---

## 4. データモデル

```typescript
interface SessionMeta {
  id: string;                  // UUID
  title?: string;              // UI 表示名 (省略時は prompt 先頭 80 文字)
  prompt: string;              // 初期プロンプト
  baseBranch: string;
  baseCommit: string;          // worktree 作成時の base branch HEAD
  worktreePath: string;        // 絶対パス
  pid?: number;                // claude プロセスの PID
  status: SessionStatus;
  createdAt: string;           // ISO8601
  endedAt?: string;
}

type SessionStatus = "running" | "waiting_human" | "stopped" | "crashed";

interface Event {
  seq: number;                 // session 内の連番 (1 始まり)
  kind: EventKind;
  timestamp: string;
  payload: unknown;
}

type EventKind =
  | "session_started"
  | "claude_assistant_message"
  | "claude_tool_use"
  | "claude_tool_result"
  | "report_submitted"
  | "escalation_requested"
  | "escalation_resolved"
  | "feedback_received"        // human → inbox
  | "feedback_fetched"         // agent が pull
  | "session_stopped"
  | "session_crashed";
```

**Report / Feedback / Escalation 自体は data model を持たない**。filename と本文が全て。number prefix が時系列を表す。

---

## 5. 実行モデル

### 5.1 セッション起動

`POST /sessions { prompt, baseBranch? }` で:

1. sessionId 採番 (UUID)
2. baseCommit を解決 (`git rev-parse <baseBranch>`)
3. `git worktree add <main>/.worktrees/<sessionId> <baseBranch>`
4. `meta.json` 書き込み
5. symlink: `<worktree>/.worqload-reports` → `<main>/.worqload/sessions/<id>/reports/`
6. `claude --input-format stream-json --output-format stream-json` を spawn (CWD = worktree, env に `WORQLOAD_SESSION_ID` と内部 API endpoint)
7. 初期 system prompt + initial user message を stdin に投入
8. status = running、`session_started` event を emit

### 5.2 イベント取り込み

- claude が stdout に流す stream-json を一行ずつパース
- 内部 `Event` に変換 → `events.ndjson` に append → WebSocket broadcast
- 取り込む種類: `assistant_message`, `tool_use`, `tool_result`, `system`
- 失敗パース行はそのまま `payload.raw` に格納してログに残す

### 5.3 feedback (human → agent、pull モデル)

**書き込み (human)**:
- `POST /sessions/:id/feedback { content, anchor? }`
- server が `feedback/inbox/NNN-<slug>.md` に書き込み (NNN は server 採番)
- `feedback_received` event を emit
- claude が現在 stdin 待ち (idle) であれば、内容ゼロのウェイクアップ message ("check inbox") を stdin に流して次 turn を起こす。feedback 本文は stdin を通らない。

**取得 (agent)**:
- agent が `worqload feedback fetch` を呼ぶ
- server が `inbox/` の全ファイルを stdout に返却し、同 tx で `read/` へ mv
- `feedback_fetched` event を emit

**SKILL の規約**: turn の頭、および長い tool 呼び出しの前後で agent は必ず `worqload feedback fetch` を呼ぶ。

**anchor 形式**: `content` の先頭に `Re: <path>:<line-start>-<line-end>\n\n` をつけて agent に渡す。`<path>` は worktree 相対 (例: `./src/foo.ts:40-50`) または symlink 越し (例: `./.worqload-reports/003-build-failed.md:12-18`)。agent は Read tool で対応ファイルを読み返して context に含める。

### 5.4 report (agent → human)

- agent が `worqload report submit --slug <slug>` を呼ぶ (本文は stdin)
- server が `reports/NNN-<slug>.md` に書き込み (NNN は server 採番)
- `report_submitted` event を emit → WS broadcast

### 5.5 escalation

**起こす (agent)**:
- agent が `worqload escalate submit --slug <slug>` (本文は stdin) を呼ぶ
- server が `asking/NNN-<slug>.md` に書き込み + status = waiting_human + `escalation_requested` event
- agent はその assistant turn を終え、stdin 待ちに入る

**解決 (human)**:
- 人間が UI で回答を入力 → server が:
  1. 回答を `feedback/inbox/NNN-<slug>.md` に書き込み (通常の feedback と同じ経路、anchor は `Re: ./.worqload-reports/asking/<resolving filename>:1-end` 相当)
  2. `asking/<resolving filename>` を `asking/resolved/` へ mv
  3. status = running、`escalation_resolved` event を emit
  4. stdin にウェイクアップ送信
- agent は次 turn の頭で `worqload feedback fetch` を呼び、回答を受け取る

### 5.6 Stop / Cancel

- **Stop**: `killProcessTree(pid)` → 数秒待って残っていれば SIGKILL → status = stopped。worktree は残す (人間が後で diff を見たい場合のため)。
- **Cancel**: Stop と同様に kill した上で `git worktree remove --force` で worktree を削除。session metadata (`meta.json`, `events.ndjson`, `reports/`, etc.) は残す。

### 5.7 クラッシュと server 再起動

- claude プロセスが非0で異常終了 → status = crashed、`session_crashed` event を emit。
- worqload server が再起動したら、`status = running | waiting_human` の session を全件 PID 確認 (`process.kill(pid, 0)` で生存判定)。死んでいれば crashed に遷移。

---

## 6. API

### 6.1 公開 REST

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/sessions` | 新規セッション作成 |
| `GET` | `/sessions` | 一覧 |
| `GET` | `/sessions/:id` | 詳細 (meta + 直近イベント) |
| `POST` | `/sessions/:id/feedback` | feedback 投入 |
| `POST` | `/sessions/:id/escalations/:eid/resolve` | escalation 解決 |
| `POST` | `/sessions/:id/stop` | Stop |
| `POST` | `/sessions/:id/cancel` | Cancel |
| `GET` | `/sessions/:id/diff?base=session-start\|base-branch` | diff 取得 |
| `GET` | `/sessions/:id/files` | worktree のファイル一覧 (tracked + 未追跡、gitignore 除外) |
| `GET` | `/sessions/:id/file?path=<relpath>` | worktree 内ファイル本文 (worktree 外パスは拒否、binary / サイズ超過はフラグのみ) |
| `GET` | `/sessions/:id/reports` | report 一覧 |
| `GET` | `/sessions/:id/reports/:filename` | report 本文 |
| `GET` | `/sessions/:id/asking` | 未解決 escalation 一覧 |

### 6.2 WebSocket

- `/sessions/:id/stream?lastSeq=N`: lastSeq 以降の event を順次送出 → 追いつき次第 live。lastSeq 未指定なら events.ndjson を最初から replay。
- `/sessions/stream`: 全 session の status_change を broadcast (一覧画面用)。

### 6.3 内部 (agent CLI が呼ぶ。localhost のみ)

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/internal/sessions/:id/reports` | 採番 + 配置 + event |
| `POST` | `/internal/sessions/:id/escalations` | 採番 + 配置 + waiting_human + event |
| `GET` | `/internal/sessions/:id/feedback` | inbox unread fetch + read 移動 |

`WORQLOAD_SESSION_ID` env var で session を識別。

---

## 7. CLI

最小構成。

| コマンド | 用途 |
|---|---|
| `worqload serve [port]` | server 起動 (default: 3456) |
| `worqload init [path]` | `.worqload/` 初期化 |
| `worqload report submit --slug <slug>` | agent 用。本文は stdin。 |
| `worqload escalate submit --slug <slug>` | agent 用。本文は stdin。 |
| `worqload feedback fetch` | agent 用。unread を stdout に。 |

---

## 8. エージェント protocol (SKILL.md 要点)

session 起動時、worqload は claude に渡す system prompt / SKILL.md に以下を含める:

- worktree (`<CWD>`) でコード作業を行うこと。
- 以下の節目で `worqload report submit --slug <slug>` を呼んで report を出すこと:
  - 計画策定後 (これからやることの宣言)
  - 大きな tool 呼び出し (build / test / 長時間スクリプト) の直前と直後
  - 一つの論理単位を完了したとき
  - 不確実性が増したとき
  - タスク完了時 (最終 report)
- 完了報告 (論理単位の完了 / タスク完了 / 「X を変更した」系の進捗報告) は、対象の変更を worktree に commit した上で出すこと。人間は report と diff を対で読むので、未コミットの変更があるとそのペアリングが崩れる。1 つの論理単位は小さな descriptive commit としてまとめる。
- 完了状態を報告しない種類の report — 初期計画、調査メモ、escalation、単一変更の途中経過 — は事前 commit 不要。
- 人間の判断が必要なときは `worqload escalate submit --slug <slug>` で質問を出し、その後 stdin で応答を待つこと。
- turn の頭、および長い tool 呼び出しの前後で `worqload feedback fetch` を呼んで inbox を確認すること。
- feedback の本文に `Re: <path>:<lines>` プレフィックスがあれば、対応するファイルを Read して context に含めること。`./.worqload-reports/` 配下は自分が書いた report への参照。
- 生ログは人間が読まないので、報告すべき内容は report に書くこと。tool の実行結果を貼るだけの薄い report ではなく、要約と判断を含めること。
- worqload 自体は merge / push / branch lifecycle を扱わない。それらは人間の責務。

---

## 9. UX

### 9.1 画面構成

#### 一覧 (top)

- セッションカード一覧。各カード:
  - status バッジ (running / waiting_human / stopped / crashed)
  - title
  - 経過時間 / 直近イベント
  - waiting_human のとき強調表示
- `+ New Session` (prompt 入力 + base branch ドロップダウン)
- `Inbox` タブで waiting_human のみフィルタ

#### 詳細

```
+----------------------------------+----------------------------------+
| Reports timeline (主)            | Diff viewer (副)                 |
|  001 plan.md                     |  base = session-start ▼          |
|    [本文]                        |  src/foo.ts                      |
|    [Reply box]                   |  ...                             |
|  002 build-failed.md             |                                  |
|    [本文]                        |                                  |
|    [Reply box]                   |                                  |
|                                  |                                  |
+----------------------------------+----------------------------------+
| Plain feedback box (常時)                                           |
+---------------------------------------------------------------------+
| ▶ Event stream (debug, 折り畳み)                                    |
+---------------------------------------------------------------------+
```

- 上部ツールバー: status, worktree branch, **Stop** / **Cancel**
- waiting_human のとき: asking/ の未解決質問が画面上部にバナー表示。応答 box が前面に出る。応答送信 = escalation resolve。
- diff viewer の行範囲選択 → 画面下の plain feedback box ではなく、選択箇所に inline で「コメントを書く」UI が出て、anchor (file + lines) が自動入力された feedback box になる。
- report timeline の行範囲選択でも同様の anchor 付き feedback。

### 9.2 主要フロー

1. **起動**: `+ New Session` → prompt 入力 → server が worktree + claude 起動 → 一覧に新カード。
2. **観測**: 詳細画面で report timeline をリアルタイム閲覧。必要に応じて diff も覗く。生ログは普段見ない。
3. **介入**: report の特定行に anchored feedback / plain feedback / diff の行に anchored feedback。送信は agent の inbox に積まれ、次 turn で agent が拾う。
4. **escalation 応答**: waiting_human セッションで質問に答えて resolve → agent が再開。
5. **完了**: 人間が満足したら **Cancel** で worktree を削除。後で diff を見たければ **Stop** で worktree を残しておく。session metadata は両者ともに残る。

---

## 10. デフォルトと未決定事項

以下は適当なデフォルトを置いた上で進める。後から容易に変更可能。

| 項目 | デフォルト |
|---|---|
| 並走数上限 | なし |
| idle timeout | なし |
| session のデータ保持 | 手動消去のみ |
| WS replay | client が `lastSeq` query を送れば差分配信、なければ最初から |
| base branch | server 起動時の HEAD 固定 (UI で変更可にするのは後回し) |
| title 自動生成 | prompt の先頭 80 文字。手動編集可。 |
| port | 3456 |

要検証 (実装中に確かめる):

- `claude --input-format stream-json` の挙動
  - turn 終了後の stdin 待ち動作
  - ウェイクアップ用の "中身ゼロ" message の許容
  - `--resume` の挙動 (本設計では使わないが、将来 v2 で使う可能性がある)

---

## 11. v2 候補

- **comment thread**: feedback の三形態目。anchor + 多発話 + resolve。アンカー安定化 (file 内容ハッシュ + 行) の reconciliation を含む。
- **MCP tool 化**: `submit_report` / `submit_escalation` / `fetch_feedback` をファイル + CLI 規約から MCP ツールに昇格。
- **inline diff 提案**: agent が diff を提案し、UI 上で accept できる。
- **multi-user**: 認証 + 同時編集の整合性。
- **multi-repo**: 一つの worqload server で複数 repo を管理。
- **network exposure**: localhost 以外への bind と auth。
- **`claude --resume`**: done session への follow-up を context 継承で実現。

---

## 12. デプロイ前提 (v1)

- localhost のみ。bind は `127.0.0.1`。
- 認証なし。
- WSL2 / Linux ネイティブ ext4 上で動作確認。Windows mount (`/mnt/c/`) 上での動作は対象外。
- `.gitignore` 編集は worqload では自動化しない。利用者が `.worqload/` と `.worqload-reports` を手動で追加する。
- `worqload serve` は main repo の toplevel から起動する前提。worktree 内からの起動は guard で弾く。
