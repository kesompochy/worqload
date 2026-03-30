import { withLock } from "../lock";

export async function loadJsonFile<T>(path: string, defaultValue: T): Promise<T> {
  return withLock(path, async () => {
    const file = Bun.file(path);
    if (!(await file.exists())) return defaultValue;
    return await file.json();
  });
}

export async function saveJsonFile<T>(path: string, data: T): Promise<void> {
  await withLock(path, async () => {
    await Bun.write(path, JSON.stringify(data, null, 2));
  });
}
