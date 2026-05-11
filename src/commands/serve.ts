import { startServer } from "../web-server";

export async function serve(args: string[]): Promise<void> {
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
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

  const { ctx } = await startServer({ port: requestedPort, spawnCommand });
  if (requestedPort !== 0 && ctx.port !== requestedPort) {
    console.log(`port ${requestedPort} was in use; using ${ctx.port} instead`);
  }
  console.log(`worqload server listening on ${ctx.baseUrlForAgent}`);
  console.log(`repo: ${ctx.repoDir}`);
  console.log(`sessions: ${ctx.sessionsDir}`);
  console.log(`spawn: ${ctx.spawnCommand.join(" ")}`);

  if (!noOpen) {
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
