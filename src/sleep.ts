import { withLock } from "./lock";

export const DEFAULT_SLEEP_PATH = ".worqload/sleep.json";

export interface SleepState {
  until: string;
}

export async function loadSleep(
  path = DEFAULT_SLEEP_PATH,
): Promise<SleepState | null> {
  return withLock(path, async () => {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return await file.json();
  });
}

export async function saveSleep(
  state: SleepState,
  path = DEFAULT_SLEEP_PATH,
): Promise<void> {
  await withLock(path, async () => {
    await Bun.write(path, JSON.stringify(state, null, 2));
  });
}

export async function clearSleep(path = DEFAULT_SLEEP_PATH): Promise<void> {
  await withLock(path, async () => {
    const file = Bun.file(path);
    if (await file.exists()) {
      const { unlink } = await import("node:fs/promises");
      await unlink(path);
    }
  });
}

export async function isSleeping(path = DEFAULT_SLEEP_PATH): Promise<boolean> {
  const state = await loadSleep(path);
  if (!state) return false;
  return new Date(state.until).getTime() > Date.now();
}

export async function sleepFor(
  minutes: number,
  path = DEFAULT_SLEEP_PATH,
): Promise<SleepState> {
  const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  const state: SleepState = { until };
  await saveSleep(state, path);
  return state;
}
