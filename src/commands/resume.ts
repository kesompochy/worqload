import type { TaskQueue } from "../queue";
import { collectResumeState, formatResumeSummary } from "../resume";

export async function resume(queue: TaskQueue, _args: string[]) {
  const state = await collectResumeState(queue);
  console.log(formatResumeSummary(state));
}
