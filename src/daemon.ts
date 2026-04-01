import { join } from "path";
import { mkdir } from "fs/promises";

export interface DaemonResult {
  pid: number;
  logPath: string;
}

export function buildDaemonCommand(missionId: string): string[] {
  return ["nohup", process.execPath, process.argv[1], "mission", "run", missionId, "--foreground"];
}

export async function launchMissionDaemon(
  missionId: string,
  options: { logDir?: string; command?: string[] } = {},
): Promise<DaemonResult> {
  const logDir = options.logDir ?? join(".worqload", "logs");
  const logPath = join(logDir, `mission-${missionId}.log`);
  await mkdir(logDir, { recursive: true });

  const cmd = options.command ?? buildDaemonCommand(missionId);

  const proc = Bun.spawn(cmd, {
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
    stdin: "ignore",
  });

  proc.unref();

  return { pid: proc.pid, logPath };
}
