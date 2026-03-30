import { mkdir } from "node:fs/promises";
import { resolve, basename } from "path";
import { registerProject } from "../projects";
import type { TaskQueue } from "../queue";
import { parseFlags } from "../utils/args";

export async function init(_queue: TaskQueue, args: string[]) {
  const { flags, rest } = parseFlags(args, ["--name"]);
  const projectPath = resolve(rest[0] || ".");
  const projectName = flags["--name"] || basename(projectPath);

  await mkdir(projectPath + "/.worqload", { recursive: true });
  console.log(`Created: ${projectPath}/.worqload/`);

  try {
    await registerProject(projectPath, projectName);
    console.log(`Registered: ${projectName} → ${projectPath}`);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("already registered")) {
      console.log(`Already registered: ${projectName}`);
    } else {
      throw e;
    }
  }

  console.log(`\nDone. Set principles with: worqload principle "<your principle>"`);
}
