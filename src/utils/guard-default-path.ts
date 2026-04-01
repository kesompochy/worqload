import { resolve } from "path";

// Captured at module load time (project root CWD) to distinguish
// the real production .worqload/ from test-isolated directories.
const PROJECT_WORQLOAD_DIR = resolve(".worqload");

/**
 * Guards against accidental writes to production data paths during test runs.
 * Bun sets NODE_ENV="test" when running `bun test`.
 *
 * Only blocks when the resolved path falls inside the project root's .worqload/.
 * Tests that chdir to a temp directory with their own .worqload/ are allowed through.
 */
export function guardDefaultPath(path: string, callerHint: string): string | undefined {
  if (process.env.NODE_ENV === "test" && path.startsWith(".worqload/")) {
    const absolute = resolve(path);
    if (absolute.startsWith(PROJECT_WORQLOAD_DIR)) {
      return undefined;
    }
  }
  return path;
}
