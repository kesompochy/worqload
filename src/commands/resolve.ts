import type { TaskQueue } from "../queue";

export function resolveTask(queue: TaskQueue, idPrefix: string | undefined) {
  if (!idPrefix) {
    console.error("Task ID required.");
    process.exit(1);
  }
  const task = queue.findById(idPrefix);
  if (!task) {
    console.error(`Task not found: ${idPrefix}`);
    process.exit(1);
  }
  return task;
}
