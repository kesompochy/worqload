import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchWebFrontend } from "../web-build";
import { startServer } from "../web-server";

// Set on the re-spawned child so it knows the outer `worqload serve --watch`
// already wrapped it in `bun --watch` and it should boot normally instead of
// forking again.
export const WATCH_RESPAWN_MARKER = "WORQLOAD_WATCH_RESPAWNED";

// Path passed down to the re-spawned child so it opens the browser exactly
// once across reload cycles: the first child to boot creates the file; later
// reloads see it and skip. The outer process removes it on exit.
const WATCH_OPEN_SENTINEL_ENV = "WORQLOAD_WATCH_OPEN_SENTINEL";

// Path passed down to the re-spawned child holding the port this watch session
// settled on. Each boot writes the port it bound; the next reload reads it and
// re-requests that port instead of falling back to the default. Without this a
// reload always retries from 3456 and "migrates" the server onto whatever lower
// port has since freed up — stealing the port a browser tab is pinned to from
// another worqload server. The outer process removes the file on exit.
const WATCH_PORT_SENTINEL_ENV = "WORQLOAD_WATCH_PORT_SENTINEL";

// Reads the port a previous boot of this watch session recorded. Returns null
// when there is no sentinel, the user gave an explicit port (their choice wins),
// or the file is unreadable / not a valid port.
export function preferredWatchPort(sentinelPath: string | undefined, explicitPort: number | null): number | null {
  if (explicitPort !== null) return null;
  if (!sentinelPath) return null;
  try {
    const port = Number(readFileSync(sentinelPath, "utf8").trim());
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

export function recordWatchPort(sentinelPath: string | undefined, port: number): void {
  if (!sentinelPath) return;
  try {
    writeFileSync(sentinelPath, String(port));
  } catch {
    /* best-effort: a missed write just means the next reload falls back */
  }
}

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

async function respawnUnderWatch(
  plan: WatchRespawnPlan,
  openSentinel: string | null,
  portSentinel: string,
): Promise<never> {
  console.log(`watch mode: respawning under \`${plan.command.slice(0, 3).join(" ")} ...\``);
  const env = { ...plan.env };
  if (openSentinel) {
    env[WATCH_OPEN_SENTINEL_ENV] = openSentinel;
    try { unlinkSync(openSentinel); } catch { /* not present */ }
  }
  env[WATCH_PORT_SENTINEL_ENV] = portSentinel;
  try { unlinkSync(portSentinel); } catch { /* not present */ }
  const child = Bun.spawn(plan.command, {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (openSentinel) {
    try { unlinkSync(openSentinel); } catch { /* already gone */ }
  }
  try { unlinkSync(portSentinel); } catch { /* already gone */ }
  process.exit(exitCode ?? 0);
}

export async function serve(args: string[]): Promise<void> {
  // --watch only affects the outer process; everything else is parsed up front
  // so the watch branch can still honour --no-open and the requested port.
  const effectiveArgs = args.filter((a) => a !== "--watch");
  const flags = new Set(effectiveArgs.filter((a) => a.startsWith("--")));
  const positional = effectiveArgs.filter((a) => !a.startsWith("--"));
  const noOpen = flags.has("--no-open");

  const explicitPort = positional[0] ? Number(positional[0]) : null;
  if (explicitPort !== null && Number.isNaN(explicitPort)) {
    console.error(`invalid port: ${positional[0]}`);
    process.exit(2);
  }
  // Under --watch the re-spawned child receives WORQLOAD_WATCH_PORT_SENTINEL and
  // prefers the port the previous boot recorded over the default.
  const portSentinel = process.env[WATCH_PORT_SENTINEL_ENV];
  const requestedPort = explicitPort ?? preferredWatchPort(portSentinel, explicitPort) ?? 3456;

  const plan = planWatchRespawn(args, {
    execPath: process.execPath,
    // process.argv[1] is the entry script bun was launched with. When invoked
    // through `bun link` this is the symlinked cli.ts; bun resolves the
    // symlink itself when watching imports.
    scriptPath: process.argv[1],
    env: process.env,
  });
  if (plan) {
    // PID-scoped so a sentinel left behind by a crashed outer never blocks a
    // future watch session.
    const openSentinel = noOpen ? null : join(tmpdir(), `worqload-watch-${process.pid}.open`);
    const portSentinelPath = join(tmpdir(), `worqload-watch-${process.pid}.port`);
    // Rebuild web/dist/ on frontend changes. This watcher lives in the outer
    // process, which stays up across the inner server's `bun --watch` reloads
    // (those only react to the server's TS import graph, not web/). The browser
    // still needs a manual reload to pick up a rebuild.
    try {
      await watchWebFrontend();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`watch mode: frontend build watcher did not start (${message}); run \`bun run web:watch\` separately`);
    }
    await respawnUnderWatch(plan, openSentinel, portSentinelPath);
    return;
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

  // WORQLOAD_DRIVER picks which SessionDriver implementation to run for each
  // session. "pipe" (default) runs `claude -p` over stdio; "tmux" runs
  // interactive `claude` inside a tmux session and reads claude's JSONL
  // transcript — the PoC route for avoiding the Agent SDK credit pool.
  const driverEnv = (process.env.WORQLOAD_DRIVER ?? "").trim();
  let driverName: "pipe" | "tmux" | undefined;
  if (driverEnv === "tmux") driverName = "tmux";
  else if (driverEnv === "pipe" || driverEnv === "") driverName = undefined;
  else {
    console.error(`unknown WORQLOAD_DRIVER: ${driverEnv} (expected 'pipe' or 'tmux')`);
    process.exit(1);
  }

  // WORQLOAD_AGENT picks which CLI worqload spawns per session. "claude"
  // (default) keeps the existing behavior; "codex" runs `codex exec --json`
  // via the codex session driver; "cursor" runs the Cursor Agent CLI.
  const agentEnv = (process.env.WORQLOAD_AGENT ?? "").trim();
  let agentName: "claude" | "codex" | "cursor" | undefined;
  if (agentEnv === "codex") agentName = "codex";
  else if (agentEnv === "cursor") agentName = "cursor";
  else if (agentEnv === "claude" || agentEnv === "") agentName = undefined;
  else {
    console.error(`unknown WORQLOAD_AGENT: ${agentEnv} (expected 'claude', 'codex', or 'cursor')`);
    process.exit(1);
  }

  const { ctx } = await startServer({
    port: requestedPort,
    spawnCommand,
    hostCommand,
    ...(driverName && { driverName }),
    ...(agentName && { agentName }),
  });
  if (requestedPort !== 0 && ctx.port !== requestedPort) {
    console.log(`port ${requestedPort} was in use; using ${ctx.port} instead`);
  }
  // Remember the port this boot settled on so the next --watch reload re-requests
  // it instead of migrating back onto the default.
  recordWatchPort(portSentinel, ctx.port);
  console.log(`worqload server listening on ${ctx.baseUrlForAgent}`);
  console.log(`repo: ${ctx.repoDir}`);
  console.log(`sessions: ${ctx.sessionsDir}`);
  console.log(`spawn: ${ctx.spawnCommand.join(" ")}`);

  if (!noOpen) {
    const sentinel = process.env[WATCH_OPEN_SENTINEL_ENV];
    if (sentinel) {
      // watch-mode child: open the actual listening URL exactly once, even
      // across reload cycles (the sentinel file marks "already opened").
      if (!existsSync(sentinel)) {
        openInBrowser(ctx.baseUrlForAgent);
        try { writeFileSync(sentinel, ctx.baseUrlForAgent); } catch { /* best-effort */ }
      }
    } else {
      openInBrowser(ctx.baseUrlForAgent);
    }
  }

  // keep the process alive
  await new Promise(() => {});
}

export function openInBrowser(url: string): void {
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
