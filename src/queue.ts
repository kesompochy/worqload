import type { Task, TaskStatus, OodaPhase, PhaseLog } from "./task";
import { validateTransition } from "./task";
import { load, save, loadArchive, appendArchive } from "./store";

export class TaskQueue {
  private tasks: Map<string, Task> = new Map();
  private storePath?: string;
  private archivePath?: string;

  constructor(storePath?: string, archivePath?: string) {
    this.storePath = storePath;
    this.archivePath = archivePath;
  }

  getStorePath(): string | undefined {
    return this.storePath;
  }

  enqueue(task: Task): void {
    this.tasks.set(task.id, task);
  }

  dequeue(): Task | undefined {
    let best: Task | undefined;
    for (const [, task] of this.tasks) {
      if (task.status !== "observing") continue;
      if (task.owner) continue;
      if (!best || task.priority > best.priority || (task.priority === best.priority && task.createdAt < best.createdAt)) {
        best = task;
      }
    }
    return best;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  findById(shortId: string): Task | undefined {
    for (const [id, task] of this.tasks) {
      if (id.startsWith(shortId)) return task;
    }
    return undefined;
  }

  update(id: string, patch: Partial<Task>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const updated = { ...task, ...patch, updatedAt: new Date().toISOString() };
    this.tasks.set(id, updated);
    return updated;
  }

  transition(id: string, newStatus: TaskStatus): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    validateTransition(task.status, newStatus);
    return this.update(id, { status: newStatus });
  }

  claim(id: string, owner: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (task.status !== "observing") {
      throw new Error(`Cannot claim: task is ${task.status}, expected observing`);
    }
    if (task.owner) {
      throw new Error(`Task already claimed by ${task.owner}`);
    }
    return this.update(id, { owner });
  }

  unclaim(id: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (!task.owner) {
      throw new Error("Task is not claimed");
    }
    return this.update(id, { owner: undefined });
  }

  addLog(id: string, phase: OodaPhase, content: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const log: PhaseLog = { phase, content, timestamp: new Date().toISOString() };
    return this.update(id, { logs: [...task.logs, log] });
  }

  remove(id: string): boolean {
    return this.tasks.delete(id);
  }

  getByMission(missionId: string): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.missionId === missionId);
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }

  async load(): Promise<void> {
    const tasks = await load(this.storePath);
    for (const task of tasks) {
      this.tasks.set(task.id, task);
    }
  }

  async save(): Promise<void> {
    await save(this.list(), this.storePath);
  }

  async archive(ids: string[]): Promise<Task[]> {
    const archived: Task[] = [];
    for (const id of ids) {
      const task = this.tasks.get(id);
      if (task) {
        archived.push(task);
        this.tasks.delete(id);
      }
    }
    if (archived.length > 0) {
      await appendArchive(archived, this.archivePath);
      await save(this.list(), this.storePath);
    }
    return archived;
  }

  async history(): Promise<Task[]> {
    return await loadArchive(this.archivePath);
  }
}
