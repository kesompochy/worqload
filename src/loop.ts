import type { Task, OodaPhase } from "./task";
import { TaskQueue } from "./queue";

export interface OodaHandlers {
  observe: (task: Task) => Promise<Task>;
  orient: (task: Task) => Promise<Task>;
  decide: (task: Task) => Promise<Task>;
  act: (task: Task) => Promise<Task>;
}

export async function runLoop(queue: TaskQueue, handlers: OodaHandlers): Promise<void> {
  const task = queue.dequeue();
  if (!task) return;

  let current = task;
  const phases = ["observing", "orienting", "deciding", "acting"] as const;
  const oodaPhases: OodaPhase[] = ["observe", "orient", "decide", "act"];
  const phaseHandlers = [handlers.observe, handlers.orient, handlers.decide, handlers.act];

  for (let i = 0; i < phases.length; i++) {
    current = queue.transition(current.id, phases[i])!;
    try {
      current = await phaseHandlers[i](current);
    } catch (error) {
      queue.addLog(current.id, oodaPhases[i], `[FAILED] ${String(error)}`);
      queue.transition(current.id, "failed");
      queue.update(current.id, { context: { ...current.context, error: String(error) } });
      return;
    }
  }

  queue.transition(current.id, "done");
}
