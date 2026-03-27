import type { Task } from "./task";

const DEFAULT_STORE_PATH = ".worqload/tasks.json";

export async function load(path: string = DEFAULT_STORE_PATH): Promise<Task[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return await file.json();
}

export async function save(tasks: Task[], path: string = DEFAULT_STORE_PATH): Promise<void> {
  await Bun.write(path, JSON.stringify(tasks, null, 2));
}
