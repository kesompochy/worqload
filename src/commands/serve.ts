import { startServer } from "../web-server";

export async function serve(args: string[]): Promise<void> {
  const port = args[0] ? Number(args[0]) : 3456;
  if (Number.isNaN(port)) {
    console.error(`invalid port: ${args[0]}`);
    process.exit(2);
  }
  // WORQLOAD_SPAWN_COMMAND lets the developer override the claude binary
  // (e.g. point at a mock during smoke tests). Words are split on whitespace.
  const spawnEnv = process.env.WORQLOAD_SPAWN_COMMAND;
  const spawnCommand = spawnEnv && spawnEnv.trim() !== ""
    ? spawnEnv.trim().split(/\s+/)
    : undefined;

  const { ctx } = await startServer({ port, spawnCommand });
  console.log(`worqload server listening on ${ctx.baseUrlForAgent}`);
  console.log(`repo: ${ctx.repoDir}`);
  console.log(`sessions: ${ctx.sessionsDir}`);
  console.log(`spawn: ${ctx.spawnCommand.join(" ")}`);
  // keep the process alive
  await new Promise(() => {});
}
