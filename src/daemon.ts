import { join } from "path";
import { mkdir } from "fs/promises";

export interface DaemonResult {
  pid: number;
  logPath: string;
}

export interface BuildDaemonCommandOptions {
  useWorktree?: boolean;
}

export function buildDaemonCommand(missionId: string, options: BuildDaemonCommandOptions = {}): string[] {
  const cmd = ["nohup", process.execPath, process.argv[1], "mission", "run", missionId, "--foreground"];
  if (options.useWorktree) {
    cmd.push("--worktree");
  }
  return cmd;
}

export async function launchMissionDaemon(
  missionId: string,
  options: { logDir?: string; command?: string[]; useWorktree?: boolean } = {},
): Promise<DaemonResult> {
  const logDir = options.logDir ?? join(".worqload", "logs");
  const logPath = join(logDir, `mission-${missionId}.log`);
  await mkdir(logDir, { recursive: true });

  const cmd = options.command ?? buildDaemonCommand(missionId, { useWorktree: options.useWorktree });

  const proc = Bun.spawn(cmd, {
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
    stdin: "ignore",
  });

  proc.unref();

  return { pid: proc.pid, logPath };
}
