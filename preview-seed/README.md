# worqload preview repo

Throwaway scratch repo used by `worqload preview` (run from a worqload worktree).
On first run `worqload preview` seeds a fresh copy of this directory into
`~/.worqload-preview` (or `$WORQLOAD_PREVIEW_REPO`); rerun with `--reset` to
recreate it. Sessions you start here, and the worktrees they create, never touch
the real worqload checkout's `.worqload/` state.

Edit `preview-seed/` in the worqload repo to change what a fresh preview repo
contains.
