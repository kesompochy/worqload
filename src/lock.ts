import { mkdir, rmdir } from "node:fs/promises";

const LOCK_TIMEOUT_MS = 10_000;
const RETRY_INTERVAL_MS = 50;

export function lockPathFor(filePath: string): string {
  return filePath + ".lock";
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Failed to acquire file lock: ${lockPath} (timeout ${LOCK_TIMEOUT_MS}ms)`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await rmdir(lockPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function withLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = lockPathFor(filePath);
  await acquireLock(lock);
  try {
    return await fn();
  } finally {
    await releaseLock(lock);
  }
}
