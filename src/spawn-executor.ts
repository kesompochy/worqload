import type { OodaPhase, PhaseLog } from "./task";
import { ESCALATION_EXIT_CODE, HUMAN_REQUIRED_PREFIX } from "./task";

export const DEFAULT_SPAWN_TIMEOUT_MS = 30 * 60 * 1000;

export class SpawnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Spawn timed out after ${timeoutMs}ms`);
    this.name = "SpawnTimeoutError";
  }
}

export interface SpawnWithTimeoutResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function killProcessTree(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}

export interface SpawnWithTimeoutOptions {
  onStart?: (pid: number) => Promise<void>;
}

export async function spawnWithTimeout(
  command: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
  cwd?: string,
  options?: SpawnWithTimeoutOptions,
): Promise<SpawnWithTimeoutResult> {
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env,
    ...(cwd ? { cwd } : {}),
  });

  console.log(`[spawn] PID ${proc.pid} started: ${command[0]} (timeout: ${Math.round(timeoutMs / 1000)}s${cwd ? `, cwd: ${cwd}` : ""})`);

  if (options?.onStart) {
    await options.onStart(proc.pid);
  }

  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      console.log(`[spawn] PID ${proc.pid} timed out after ${Math.round(timeoutMs / 1000)}s`);
      killProcessTree(proc.pid);
      reject(new SpawnTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  const completionPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    clearTimeout(timeoutId);
    console.log(`[spawn] PID ${proc.pid} exited: code=${exitCode}, stdout=${stdout.length}B, stderr=${stderr.length}B`);
    if (exitCode !== 0) {
      const output = (stdout + stderr).trim();
      if (output) console.log(`[spawn] PID ${proc.pid} output: ${output.slice(0, 500)}`);
    }
    return { stdout, stderr, exitCode };
  })();

  return Promise.race([completionPromise, timeoutPromise]);
}

export function truncateOutput(output: string, maxLength: number = 2000): string {
  if (output.length <= maxLength) return output;
  return output.slice(-maxLength);
}

export interface BuildTaskEnvInput {
  taskId: string;
  taskTitle: string;
  taskContext: Record<string, unknown>;
  missionPrinciples?: string[];
}

export function phaseLog(phase: OodaPhase, content: string): PhaseLog {
  return { phase, content, timestamp: new Date().toISOString() };
}

export interface RetryPolicy {
  canRetry: (context: Record<string, unknown>) => boolean;
  computeRetry: (context: Record<string, unknown>) => { retryCount: number; retryAfter: string };
  maxRetries: number;
}

export interface TaskSnapshot {
  logs: PhaseLog[];
  status: string;
  context: Record<string, unknown>;
}

export interface SpawnOutcomeUpdate {
  status?: "done" | "waiting_human" | "failed" | "observing";
  logs: PhaseLog[];
  owner: undefined;
  context?: Record<string, unknown>;
}

export function buildSpawnOutcomeUpdate(
  exitCode: number,
  truncatedOutput: string,
  current: TaskSnapshot,
  options?: { retryPolicy?: RetryPolicy; skipRetry?: boolean },
): SpawnOutcomeUpdate {
  const logs: PhaseLog[] = [...current.logs, phaseLog("act", truncatedOutput)];

  if (current.status === "done" || current.status === "failed") {
    return { logs, owner: undefined };
  }

  if (exitCode === 0) {
    return { status: "done", logs, owner: undefined };
  }

  if (exitCode === ESCALATION_EXIT_CODE) {
    const question = truncatedOutput || "Spawned agent requested human escalation";
    return {
      status: "waiting_human",
      logs: [...logs, phaseLog("orient", `${HUMAN_REQUIRED_PREFIX}${question}`)],
      owner: undefined,
    };
  }

  const retry = options?.retryPolicy;
  if (retry && !options?.skipRetry && retry.canRetry(current.context)) {
    const { retryCount, retryAfter } = retry.computeRetry(current.context);
    return {
      status: "observing",
      logs: [...logs, phaseLog("act", `[RETRY] ${retryCount}/${retry.maxRetries} - exit code ${exitCode}`)],
      owner: undefined,
      context: { ...current.context, retryCount, retryAfter },
    };
  }

  return {
    status: "failed",
    logs: [...logs, phaseLog("act", `[FAILED] exit code ${exitCode}`)],
    owner: undefined,
  };
}

export function buildSpawnTimeoutUpdate(
  timeoutMs: number,
  current: TaskSnapshot,
  options?: { retryPolicy?: RetryPolicy; skipRetry?: boolean },
): SpawnOutcomeUpdate {
  const retry = options?.retryPolicy;
  if (retry && !options?.skipRetry && retry.canRetry(current.context)) {
    const { retryCount, retryAfter } = retry.computeRetry(current.context);
    return {
      status: "observing",
      owner: undefined,
      context: { ...current.context, retryCount, retryAfter },
      logs: [...current.logs, phaseLog("act", `[TIMEOUT] Spawn timed out after ${timeoutMs}ms`)],
    };
  }

  const logs: PhaseLog[] = [...current.logs, phaseLog("act", `[TIMEOUT] Spawn timed out after ${timeoutMs}ms`)];
  if (retry) {
    logs.push(phaseLog("act", `[FAILED] timeout after ${retry.maxRetries} retries`));
  }

  return { status: "failed", owner: undefined, logs };
}

export function buildTaskEnv(input: BuildTaskEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    WORQLOAD_CLI: Bun.which("worqload") ?? process.argv[0],
    WORQLOAD_TASK_ID: input.taskId,
    WORQLOAD_TASK_TITLE: input.taskTitle,
    WORQLOAD_TASK_CONTEXT: JSON.stringify(input.taskContext),
  };

  if (input.missionPrinciples && input.missionPrinciples.length > 0) {
    env.WORQLOAD_MISSION_PRINCIPLES = input.missionPrinciples.join("\n");
  }

  return env;
}
