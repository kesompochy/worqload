import { loadJsonFile, saveJsonFile } from "./json-store";

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

  async save(items: T[], path: string = this.defaultPath): Promise<void> {
    await saveJsonFile(path, items);
  }

  async add(entity: T, path: string = this.defaultPath): Promise<T> {
    const items = await this.load(path);
    items.push(entity);
    await this.save(items, path);
    return entity;
  }

  findByIdOrPrefix(items: T[], id: string): T | undefined {
    return items.find(item => item.id === id || item.id.startsWith(id));
  }

  async update(id: string, changes: Partial<T>, path: string = this.defaultPath): Promise<T> {
    const items = await this.load(path);
    const item = this.findByIdOrPrefix(items, id);
    if (!item) throw new Error(`${this.entityName} not found: ${id}`);
    Object.assign(item, changes);
    await this.save(items, path);
    return item;
  }

  async remove(id: string, path: string = this.defaultPath): Promise<void> {
    const items = await this.load(path);
    const filtered = items.filter(item => item.id !== id && !item.id.startsWith(id));
    if (filtered.length === items.length) throw new Error(`${this.entityName} not found: ${id}`);
    await this.save(filtered, path);
  }
}
