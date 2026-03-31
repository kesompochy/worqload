import { loadJsonFile, loadJsonFileUnlocked, saveJsonFile } from "./json-store";
import { withLock } from "../lock";

export class EntityStore<T extends { id: string }> {
  private readonly defaultPath: string;
  private readonly entityName: string;

  constructor(defaultPath: string, entityName: string = "Entity") {
    this.defaultPath = defaultPath;
    this.entityName = entityName;
  }

  async load(path: string = this.defaultPath): Promise<T[]> {
    return loadJsonFile<T[]>(path, []);
  }

  async loadUnlocked(path: string = this.defaultPath): Promise<T[]> {
    return loadJsonFileUnlocked<T[]>(path, []);
  }

  async save(items: T[], path: string = this.defaultPath): Promise<void> {
    await saveJsonFile(path, items);
  }

  async add(entity: T, path: string = this.defaultPath): Promise<T> {
    await withLock(path, async () => {
      const items = await loadJsonFileUnlocked<T[]>(path, []);
      items.push(entity);
      await Bun.write(path, JSON.stringify(items, null, 2));
    });
    return entity;
  }

  findByIdOrPrefix(items: T[], id: string): T | undefined {
    return items.find(item => item.id === id || item.id.startsWith(id));
  }

  async update(id: string, changes: Partial<T>, path: string = this.defaultPath): Promise<T> {
    return withLock(path, async () => {
      const items = await loadJsonFileUnlocked<T[]>(path, []);
      const item = this.findByIdOrPrefix(items, id);
      if (!item) throw new Error(`${this.entityName} not found: ${id}`);
      Object.assign(item, changes);
      await Bun.write(path, JSON.stringify(items, null, 2));
      return item;
    });
  }

  async remove(id: string, path: string = this.defaultPath): Promise<void> {
    await withLock(path, async () => {
      const items = await loadJsonFileUnlocked<T[]>(path, []);
      const filtered = items.filter(item => item.id !== id && !item.id.startsWith(id));
      if (filtered.length === items.length) throw new Error(`${this.entityName} not found: ${id}`);
      await Bun.write(path, JSON.stringify(filtered, null, 2));
    });
  }
}
