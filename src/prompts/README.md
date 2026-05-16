# prompts

Plain-text prompts sent to `claude`. Loaded by the server via Bun's
`import x from "./foo.txt" with { type: "text" }`; `bun build --compile`
embeds the file content into the binary.

Dynamic values use `{{placeholder}}` tokens, substituted by the importing
module (e.g. `protocol-prefix.txt` carries `{{baseBranch}}`).

| file | used by |
| --- | --- |
| `protocol-prefix.txt` | `session-bootstrap.ts` — prepended to the first user message |
| `resume-kickoff.txt` | `session-bootstrap.ts` — first message when a host respawns in resume mode |
| `branch-name-instruction.txt` | `branch-name.ts` — instruction for the `claude -p` branch-name generator |

Asserting that a prompt contains a specific string is out of scope for
automated tests. Wording is tuned constantly; substring assertions break on
every reword without catching real regressions. Test the wiring, not the
wording.
