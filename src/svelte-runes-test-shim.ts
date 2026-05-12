// Preloaded by `bun test` (see bunfig.toml). The frontend's `.svelte.js`
// modules (e.g. web/state.svelte.js) use Svelte 5 runes like `$state`, which
// the Svelte compiler rewrites in the browser build but `bun test` — which
// loads those modules directly — does not know about. The tests that touch
// `state` only read plain values, so an identity stand-in is enough to let the
// module load.
//
// biome-ignore lint/suspicious/noExplicitAny: minimal global stand-in for a compiler macro
const g = globalThis as any;
g.$state ??= <T>(value: T): T => value;
