import type { Task } from "./task";

const DEFAULT_STORE_PATH = ".worqload/tasks.json";
const DEFAULT_ARCHIVE_PATH = ".worqload/archive.json";

export async function load(path: string = DEFAULT_STORE_PATH): Promise<Task[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const tasks: Task[] = await file.json();
  return tasks.map(task => ({ priority: 0, ...task }));
}

export async function save(tasks: Task[], path: string = DEFAULT_STORE_PATH): Promise<void> {
  await Bun.write(path, JSON.stringify(tasks, null, 2));
}

export async function loadArchive(path: string = DEFAULT_ARCHIVE_PATH): Promise<Task[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const tasks: Task[] = await file.json();
  return tasks.map(task => ({ priority: 0, ...task }));
}

export async function appendArchive(tasks: Task[], path: string = DEFAULT_ARCHIVE_PATH): Promise<void> {
  const existing = await loadArchive(path);
  await Bun.write(path, JSON.stringify([...existing, ...tasks], null, 2));
}
