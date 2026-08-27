import { startArchiveServer } from "../archive-server";

export async function archiveUi(args: string[]): Promise<void> {
  const portArg = args.find(a => /^\d+$/.test(a));
  const port = portArg ? Number(portArg) : undefined;
  const noOpen = args.includes("--no-open");

  const { server } = await startArchiveServer({ port });
  const url = `http://127.0.0.1:${server.port}`;
  console.log(`archive-ui listening on ${url}`);

  if (!noOpen) {
    try {
      const { exec } = await import("node:child_process");
      exec(`open ${url}`);
    } catch { /* non-fatal */ }
  }

  await new Promise(() => {});
}
