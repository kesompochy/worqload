import { loadJsonFile, loadJsonFileUnlocked, saveJsonFile } from "./json-store";
import { withLock } from "../lock";
import { guardDefaultPath } from "./guard-default-path";

export class EntityStore<T extends { id: string }> {
  private readonly defaultPath: string;
  private readonly entityName: string;

  constructor(defaultPath: string, entityName: string = "Entity") {
    this.defaultPath = defaultPath;
    this.entityName = entityName;
  }

  private resolve(path?: string): string | undefined {
    if (path) return path;
    return guardDefaultPath(this.defaultPath, this.entityName);
  }

  async load(path?: string): Promise<T[]> {
    const resolved = this.resolve(path);
    if (!resolved) return [];
    return loadJsonFile<T[]>(resolved, []);
  }

  async loadUnlocked(path?: string): Promise<T[]> {
    const resolved = this.resolve(path);
    if (!resolved) return [];
    return loadJsonFileUnlocked<T[]>(resolved, []);
  }

  async save(items: T[], path?: string): Promise<void> {
    const resolved = this.resolve(path);
    if (!resolved) return;
    await saveJsonFile(resolved, items);
  }

  async add(entity: T, path?: string): Promise<T> {
    const resolved = this.resolve(path);
    if (!resolved) return entity;
    await withLock(resolved, async () => {
      const items = await loadJsonFileUnlocked<T[]>(resolved, []);
      items.push(entity);
      await Bun.write(resolved, JSON.stringify(items, null, 2));
    });
    return entity;
  }

  findByIdOrPrefix(items: T[], id: string): T | undefined {
    return items.find(item => item.id === id || item.id.startsWith(id));
  }

  async update(id: string, changes: Partial<T>, path?: string): Promise<T> {
    const resolved = this.resolve(path);
    if (!resolved) return { id, ...changes } as T;
    return withLock(resolved, async () => {
      const items = await loadJsonFileUnlocked<T[]>(resolved, []);
      const item = this.findByIdOrPrefix(items, id);
      if (!item) throw new Error(`${this.entityName} not found: ${id}`);
      Object.assign(item, changes);
      await Bun.write(resolved, JSON.stringify(items, null, 2));
      return item;
    });
  }

  async remove(id: string, path?: string): Promise<void> {
    const resolved = this.resolve(path);
    if (!resolved) return;
    await withLock(resolved, async () => {
      const items = await loadJsonFileUnlocked<T[]>(resolved, []);
      const filtered = items.filter(item => item.id !== id && !item.id.startsWith(id));
      if (filtered.length === items.length) throw new Error(`${this.entityName} not found: ${id}`);
      await Bun.write(resolved, JSON.stringify(filtered, null, 2));
    });
  }
}
