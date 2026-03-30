import type { TaskQueue } from "../queue";
import { sleepFor, clearSleep, isSleeping, loadSleep } from "../sleep";

export async function heartbeat(_queue: TaskQueue, args: string[]) {
  const intervalSeconds = Number(args[0]) || 300;
  const data = { lastRun: new Date().toISOString(), intervalSeconds };
  await Bun.write(".worqload/heartbeat.json", JSON.stringify(data));
  console.log(`Heartbeat: interval=${intervalSeconds}s`);
}

export async function sleep(_queue: TaskQueue, args: string[]) {
  const minutes = Number(args[0]);
  if (!minutes || minutes <= 0) {
    const sleeping = await isSleeping();
    if (sleeping) {
      const state = await loadSleep();
      const remaining = Math.ceil(
        (new Date(state!.until).getTime() - Date.now()) / 60000,
      );
      console.log(`Sleeping for ${remaining} more minute(s) (until ${state!.until})`);
    } else {
      console.log("Not sleeping.");
    }
    return;
  }
  const state = await sleepFor(minutes);
  console.log(`Sleeping until ${state.until} (${minutes} minutes)`);
}

export async function wake(_queue: TaskQueue, _args: string[]) {
  await clearSleep();
  console.log("Awake.");
}

export async function serve(_queue: TaskQueue, args: string[]) {
  const port = Number(args[0]) || 3456;
  const { startServer } = await import("../server");
  startServer(port);
}
