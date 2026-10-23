// Preloaded by `bun test` (see bunfig.toml). Points core.hooksPath of every
// `git` the suite spawns — directly or through the code under test, which
// inherits process.env — at a path with no hooks, so the developer's global
// hooks do not run on the hundreds of commits and `worktree add`s the tests
// make. Those hooks cost several hundred ms per git call and pushed git-heavy
// tests past the 5s timeout when files run in parallel. GIT_CONFIG_COUNT is
// appended to rather than overwritten to keep any entries already set.
const index = Number(process.env.GIT_CONFIG_COUNT ?? 0);
process.env[`GIT_CONFIG_KEY_${index}`] = "core.hooksPath";
process.env[`GIT_CONFIG_VALUE_${index}`] = "/dev/null";
process.env.GIT_CONFIG_COUNT = String(index + 1);
