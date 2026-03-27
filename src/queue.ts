import type { Task, TaskStatus, OodaPhase, PhaseLog } from "./task";
import { validateTransition } from "./task";
import { load, save } from "./store";

export class TaskQueue {
  private tasks: Map<string, Task> = new Map();

  enqueue(task: Task): void {
    this.tasks.set(task.id, task);
  }

  dequeue(): Task | undefined {
    for (const [, task] of this.tasks) {
      if (task.status === "pending") {
        return task;
      }
    }
    return undefined;
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

  addLog(id: string, phase: OodaPhase, content: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const log: PhaseLog = { phase, content, timestamp: new Date().toISOString() };
    return this.update(id, { logs: [...task.logs, log] });
  }

  remove(id: string): boolean {
    return this.tasks.delete(id);
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }

  async load(): Promise<void> {
    const tasks = await load();
    for (const task of tasks) {
      this.tasks.set(task.id, task);
    }
  }

  async save(): Promise<void> {
    await save(this.list());
  }
}
