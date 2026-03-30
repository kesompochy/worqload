import { exitWithError } from "../utils/errors";
import type { TaskQueue } from "../queue";

export function resolveTask(queue: TaskQueue, idPrefix: string | undefined) {
  if (!idPrefix) {
    exitWithError("Task ID required.");
  }
  const task = queue.findById(idPrefix);
  if (!task) {
    exitWithError(`Task not found: ${idPrefix}`);
  }
  return task;
}
