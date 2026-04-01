/**
 * Guards against accidental writes to production data paths during test runs.
 * Bun sets NODE_ENV="test" when running `bun test`.
 *
 * Returns the resolved path, or undefined if in test mode and using the default
 * production path. Callers that receive undefined should skip the operation.
 */
export function guardDefaultPath(path: string, callerHint: string): string | undefined {
  if (process.env.NODE_ENV === "test" && path.startsWith(".worqload/")) {
    return undefined;
  }
  return path;
}
