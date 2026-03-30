import { exitWithError } from "../utils/errors";
import type { TaskQueue } from "../queue";
import { loadProjects, registerProject, removeProject } from "../projects";
import { parseFlags } from "../utils/args";

export async function project(_queue: TaskQueue, args: string[]) {
  if (args[0] === "register") {
    const { flags, rest } = parseFlags(args.slice(1), ["--name"]);
    const projectPath = rest[0] || process.cwd();
    const name = flags["--name"];
    const p = await registerProject(projectPath, name);
    console.log(`Registered: ${p.name} → ${p.path}`);
    return;
  }
  if (args[0] === "remove") {
    if (!args[1]) {
      exitWithError("Usage: worqload project remove <name>");
    }
    await removeProject(args[1]);
    console.log(`Removed: ${args[1]}`);
    return;
  }
  const projects = await loadProjects();
  if (projects.length === 0) {
    console.log("No projects registered.");
    console.log("Usage: worqload project register [path] [--name N]");
    return;
  }
  for (const p of projects) {
    console.log(`  ${p.name}: ${p.path}`);
  }
}
