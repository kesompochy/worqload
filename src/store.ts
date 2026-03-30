import type { Task } from "./task";
import { withLock } from "./lock";

const DEFAULT_STORE_PATH = ".worqload/tasks.json";
const DEFAULT_ARCHIVE_PATH = ".worqload/archive.json";

function ensureDefaults(task: Task): Task {
  return { priority: 0, ...task };
}

export async function load(path: string = DEFAULT_STORE_PATH): Promise<Task[]> {
  return withLock(path, async () => {
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const tasks: Task[] = await file.json();
    return tasks.map(ensureDefaults);
  });
}

export async function save(tasks: Task[], path: string = DEFAULT_STORE_PATH): Promise<void> {
  await withLock(path, async () => {
    await Bun.write(path, JSON.stringify(tasks, null, 2));
  });
}

export async function loadArchive(path: string = DEFAULT_ARCHIVE_PATH): Promise<Task[]> {
  return withLock(path, async () => {
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const tasks: Task[] = await file.json();
    return tasks.map(ensureDefaults);
  });
}

export async function appendArchive(tasks: Task[], path: string = DEFAULT_ARCHIVE_PATH): Promise<void> {
  await withLock(path, async () => {
    const existing = await loadArchiveUnlocked(path);
    await Bun.write(path, JSON.stringify([...existing, ...tasks], null, 2));
  });
}

async function loadArchiveUnlocked(path: string): Promise<Task[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const tasks: Task[] = await file.json();
  return tasks.map(ensureDefaults);
}
