import type { TaskQueue } from "../queue";

export async function heartbeat(_queue: TaskQueue, args: string[]) {
  const intervalSeconds = Number(args[0]) || 300;
  const data = { lastRun: new Date().toISOString(), intervalSeconds };
  await Bun.write(".worqload/heartbeat.json", JSON.stringify(data));
  console.log(`Heartbeat: interval=${intervalSeconds}s`);
}

export async function serve(_queue: TaskQueue, args: string[]) {
  const port = Number(args[0]) || 3456;
  const { startServer } = await import("../server");
  startServer(port);
}
