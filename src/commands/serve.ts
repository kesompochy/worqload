import { startServer } from "../web-server";

// Set on the re-spawned child so it knows the outer `worqload serve --watch`
// already wrapped it in `bun --watch` and it should boot normally instead of
// forking again.
export const WATCH_RESPAWN_MARKER = "WORQLOAD_WATCH_RESPAWNED";

export interface WatchRespawnPlan {
  command: string[];
  env: Record<string, string>;
}

export interface WatchRespawnOptions {
  execPath: string;
  scriptPath: string;
  env: Record<string, string | undefined>;
}

export function planWatchRespawn(args: string[], options: WatchRespawnOptions): WatchRespawnPlan | null {
  if (!args.includes("--watch")) return null;
  if (options.env[WATCH_RESPAWN_MARKER]) return null;

  const filtered = args.filter((a) => a !== "--watch");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.env)) {
    if (v !== undefined) env[k] = v;
  }
  env[WATCH_RESPAWN_MARKER] = "1";

  return {
    command: [options.execPath, "--watch", options.scriptPath, "serve", ...filtered],
    env,
  };
}

async function respawnUnderWatch(plan: WatchRespawnPlan): Promise<never> {
  console.log(`watch mode: respawning under \`${plan.command.slice(0, 3).join(" ")} ...\``);
  const child = Bun.spawn(plan.command, {
    env: plan.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  process.exit(exitCode ?? 0);
}

export async function serve(args: string[]): Promise<void> {
  const plan = planWatchRespawn(args, {
    execPath: process.execPath,
    // process.argv[1] is the entry script bun was launched with. When invoked
    // through `bun link` this is the symlinked cli.ts; bun resolves the
    // symlink itself when watching imports.
    scriptPath: process.argv[1],
    env: process.env,
  });
  if (plan) {
    await respawnUnderWatch(plan);
    return;
  }

  // Strip --watch in case we are the re-spawned child.
  const effectiveArgs = args.filter((a) => a !== "--watch");
  const flags = new Set(effectiveArgs.filter((a) => a.startsWith("--")));
  const positional = effectiveArgs.filter((a) => !a.startsWith("--"));
  const noOpen = flags.has("--no-open");

  const requestedPort = positional[0] ? Number(positional[0]) : 3456;
  if (Number.isNaN(requestedPort)) {
    console.error(`invalid port: ${positional[0]}`);
    process.exit(2);
  }
  // WORQLOAD_SPAWN_COMMAND lets the developer override the claude binary
  // (e.g. point at a mock during smoke tests). Words are split on whitespace.
  const spawnEnv = process.env.WORQLOAD_SPAWN_COMMAND;
  const spawnCommand = spawnEnv && spawnEnv.trim() !== ""
    ? spawnEnv.trim().split(/\s+/)
    : undefined;

  // WORQLOAD_HOST_COMMAND is the equivalent escape hatch for the per-session
  // host launcher. Required when running serve in an environment where the
  // installed `worqload` binary isn't on PATH (e.g. local dev without
  // `bun link`).
  const hostEnv = process.env.WORQLOAD_HOST_COMMAND;
  const hostCommand = hostEnv && hostEnv.trim() !== ""
    ? hostEnv.trim().split(/\s+/)
    : undefined;

  const { ctx } = await startServer({ port: requestedPort, spawnCommand, hostCommand });
  if (requestedPort !== 0 && ctx.port !== requestedPort) {
    console.log(`port ${requestedPort} was in use; using ${ctx.port} instead`);
  }
  console.log(`worqload server listening on ${ctx.baseUrlForAgent}`);
  console.log(`repo: ${ctx.repoDir}`);
  console.log(`sessions: ${ctx.sessionsDir}`);
  console.log(`spawn: ${ctx.spawnCommand.join(" ")}`);

  // Re-spawned children skip the browser open because the original parent
  // (or a previous reload cycle) already opened it.
  if (!noOpen && !process.env[WATCH_RESPAWN_MARKER]) {
    openInBrowser(ctx.baseUrlForAgent);
  }

  // keep the process alive
  await new Promise(() => {});
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`could not open browser (${cmd[0]}): ${message}`);
  }
}
