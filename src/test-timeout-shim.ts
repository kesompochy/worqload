// Preloaded by `bun test` (see bunfig.toml). Medium tests spawn dozens of real
// `git` processes each; a test that takes ~2s on an idle machine passes 5s, Bun's
// default per-test timeout, when other test files or sessions load the CPU.
// Bun 1.3.14 ignores `timeout` in bunfig.toml, so the default is raised here.
// A real hang is still bounded by this limit and, under `bun run test`, by the
// per-file limit in scripts/test-files.ts.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(20_000);
