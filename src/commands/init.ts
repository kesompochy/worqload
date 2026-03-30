import { mkdir } from "node:fs/promises";
import { resolve, basename } from "path";
import { registerProject } from "../projects";
import type { TaskQueue } from "../queue";

export async function init(_queue: TaskQueue, args: string[]) {
  const projectPath = resolve(args[0] || ".");
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) { name = args[i + 1]; break; }
  }
  const projectName = name || basename(projectPath);

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
