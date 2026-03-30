# A2A（Agent-to-Agent）プロトコル調査

## 概要

異なるAIエージェント同士が、互いの内部状態やツールにアクセスせずに協調作業を行うための**オープン通信プロトコル**。

- **発表**: Google（2025年4月 Cloud Next）
- **ガバナンス**: Linux Foundation
- **ライセンス**: Apache 2.0
- **参加組織**: 150以上（Atlassian, Salesforce, SAP, Langchain等）
- **公式サイト**: https://a2a-protocol.org/latest/
- **GitHub**: https://github.com/a2aproject/A2A

## MCPとの関係

| | MCP (Anthropic) | A2A (Google) |
|---|---|---|
| **方向** | エージェント → ツール/データ（縦） | エージェント ⇔ エージェント（横） |
| **役割** | ツール接続の標準化 | エージェント間協調の標準化 |
| **関係** | **補完関係** | **補完関係** |

## 技術アーキテクチャ

### クライアント・サーバーモデル

- **A2A Client**: タスクを依頼する側
- **A2A Server**: エンドポイントを公開しタスクを処理する側

### コアコンセプト

| 概念 | 説明 |
|---|---|
| **Agent Card** | エージェントのID・スキル・認証要件を記述するJSON。`/.well-known/agent-card.json`で公開 |
| **Task** | 作業の基本単位。ステートフルなライフサイクルを持つ |
| **Message** | クライアント⇔エージェント間の通信ターン |
| **Part** | テキスト・ファイル・構造化データ等のコンテンツ単位 |
| **Artifact** | エージェントが生成した出力物 |

### タスク状態遷移

```
created → working → completed / failed / canceled
                  → input_required（追加入力待ち）
                  → auth_required / rejected
```

### トランスポート

- JSON-RPC 2.0 over HTTPS
- gRPC（v0.3〜）
- HTTP+REST

### 更新配信

- ポーリング
- SSEストリーミング
- Webhookプッシュ通知

## worqloadとの統合可能性

### 1. worqloadをA2A Serverとして公開

Agent Cardを`/.well-known/agent-card.json`に配置し、外部エージェントからworqloadのタスクキューにタスクを投入できるようにする。

**状態マッピング**:

| worqload | A2A |
|---|---|
| pending | created |
| observing / orienting / deciding / acting | working |
| waiting_human | input_required |
| done | completed |
| failed | failed |

### 2. worqloadをA2A Clientとして利用

OODAのactフェーズで、専門エージェント（コードレビュー、テスト実行、デプロイ等）にA2A経由でサブタスクを委譲。各エージェントの内部実装を知る必要がない。

### 3. waiting_human と input_required の対応

worqloadの「人間待ち」状態はA2Aの`input_required`に自然にマッピングでき、外部クライアントから人間の応答を注入する標準的なインターフェースになる。

### 4. マルチエージェントオーケストレーション

複数のworqloadインスタンスがA2A経由で協調し、それぞれが異なるドメインのOODAループを回すアーキテクチャが可能。
