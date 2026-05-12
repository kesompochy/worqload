// Tests create throwaway git repos under os.tmpdir(). Without this, those repos
// inherit the developer's global/system git config — most importantly
// core.hooksPath — so every `git commit` / `git checkout` runs the user's
// pre-commit (gitleaks, branch protection) and post-checkout hooks. That hook
// overhead dominated the test suite's wall time. Point git at empty config
// files so test repos are hermetic.
process.env.GIT_CONFIG_GLOBAL ??= "/dev/null";
process.env.GIT_CONFIG_SYSTEM ??= "/dev/null";
