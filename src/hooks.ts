import { loadConfig } from "./config";

export async function runOnDoneHooks(taskId: string, taskTitle: string, configPath?: string): Promise<void> {
  const config = await loadConfig(configPath);
  const hooks = config.onDone;
  if (!hooks || hooks.length === 0) return;

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    WORQLOAD_DONE_TASK_ID: taskId,
    WORQLOAD_DONE_TASK_TITLE: taskTitle,
  };

  for (const command of hooks) {
    const proc = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`onDone hook failed (exit ${exitCode}): ${stderr.trim()}`);
    }
  }
}
