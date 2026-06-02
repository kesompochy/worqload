# worqload

A browser UI for observing and steering parallel `claude` / `codex` sessions.

It narrows the human's role to Orient alone and raises its load average by running many sessions at once: the agents handle Observe / Decide / Act, the human watches and replies asynchronously. worqload stops at showing the diff — merge, commit, and branch lifecycle stay with the human.

## Development

```sh
bun install
bun test
bun run dev          # `worqload serve` under --watch
bun run preview      # try this checkout's UI against a throwaway ~/.worqload-preview repo (use from a worktree before merging)
```

Run `worqload` with no arguments to list the CLI subcommands.

Drop a `favicon.{svg,png,ico,jpg,gif,webp}` into a repo's `.worqload/` directory to override the browser-tab icon; without one, a built-in default is served.

## Configuration

worqload reads `~/.config/worqload/config.yaml` (a missing file is fine — it just means no rules). Edits take effect on the next report submission, so there is no need to restart the server after changing it.

### textlint

When a session has revise mode on, every report it submits is checked against a list of forbidden strings before being stored. A report containing one is bounced back to the session — with the rule's `comment` — instead of being stored, so the session rewrites it. Matching is plain substring matching.

```yaml
textlint:
  - string: "可能性"
    comment: 統計的事実のときだけ使う
  - string: "強い"
    comment: 効果を表す曖昧語は避ける
```

To keep a flagged word on purpose — for example when a report needs to quote it — prefix that occurrence with a backslash: `\可能性`. The backslash exempts only that occurrence from the lint and is kept in the stored report verbatim, so reports may contain `\` freely.

### reviseFeedback

When revise mode holds a report's first submission, the bounce message asks the session to tighten the draft. The editorial guidance in that message — how to revise — is configurable; the surrounding scaffold (where the draft was saved, the resubmit command) is fixed. Set `reviseFeedback` to replace the default guidance with your own.

```yaml
reviseFeedback: |
  結論から書け。一文を短く保ち、自己弁護・謝罪・冗長な前置き・会話調を削れ。
  レポートは記録であって会話の一手ではない。
```

Omit the key to use the built-in guidance.

