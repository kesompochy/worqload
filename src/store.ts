import type { Task } from "./task";
import { withLock } from "./lock";
import { guardDefaultPath } from "./utils/guard-default-path";

const DEFAULT_STORE_PATH = ".worqload/tasks.json";
const DEFAULT_ARCHIVE_PATH = ".worqload/archive.json";

function resolveStorePath(path?: string): string | undefined {
  if (path) return path;
  return guardDefaultPath(DEFAULT_STORE_PATH, "Store");
}

function resolveArchivePath(path?: string): string | undefined {
  if (path) return path;
  return guardDefaultPath(DEFAULT_ARCHIVE_PATH, "Archive");
}

function ensureDefaults(task: Task): Task {
  return { priority: 0, ...task };
}

export async function load(path?: string): Promise<Task[]> {
  const resolved = resolveStorePath(path);
  if (!resolved) return [];
  return withLock(resolved, async () => {
    const file = Bun.file(resolved);
    if (!(await file.exists())) return [];
    const tasks: Task[] = await file.json();
    return tasks.map(ensureDefaults);
  });
}

export async function save(tasks: Task[], path?: string): Promise<void> {
  const resolved = resolveStorePath(path);
  if (!resolved) return;
  await withLock(resolved, async () => {
    await Bun.write(resolved, JSON.stringify(tasks, null, 2));
  });
}

export async function loadArchive(path?: string): Promise<Task[]> {
  const resolved = resolveArchivePath(path);
  if (!resolved) return [];
  return withLock(resolved, async () => {
    const file = Bun.file(resolved);
    if (!(await file.exists())) return [];
    const tasks: Task[] = await file.json();
    return tasks.map(ensureDefaults);
  });
}

export async function appendArchive(tasks: Task[], path?: string): Promise<void> {
  const resolved = resolveArchivePath(path);
  if (!resolved) return;
  await withLock(resolved, async () => {
    const existing = await loadArchiveUnlocked(resolved);
    await Bun.write(resolved, JSON.stringify([...existing, ...tasks], null, 2));
  });
}

export async function updateTask(id: string, patchOrFn: Partial<Task> | ((current: Task) => Partial<Task>), path?: string): Promise<Task | undefined> {
  const resolved = resolveStorePath(path);
  if (!resolved) return undefined;
  return withLock(resolved, async () => {
    const file = Bun.file(resolved);
    if (!(await file.exists())) return undefined;
    const tasks: Task[] = (await file.json()).map(ensureDefaults);
    const index = tasks.findIndex(t => t.id === id);
    if (index === -1) return undefined;
    const patch = typeof patchOrFn === "function" ? patchOrFn(tasks[index]) : patchOrFn;
    tasks[index] = { ...tasks[index], ...patch, updatedAt: new Date().toISOString() };
    await Bun.write(resolved, JSON.stringify(tasks, null, 2));
    return tasks[index];
  });
}

async function loadArchiveUnlocked(path: string): Promise<Task[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const tasks: Task[] = await file.json();
  return tasks.map(ensureDefaults);
}
