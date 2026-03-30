import type { TaskQueue } from "../queue";
import { loadProjects, registerProject, removeProject } from "../projects";

export async function project(_queue: TaskQueue, args: string[]) {
  if (args[0] === "register") {
    const projectPath = args[1] || process.cwd();
    let name: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--name" && i + 1 < args.length) {
        name = args[i + 1];
        break;
      }
    }
    const p = await registerProject(projectPath, name);
    console.log(`Registered: ${p.name} → ${p.path}`);
    return;
  }
  if (args[0] === "remove") {
    if (!args[1]) {
      console.error("Usage: worqload project remove <name>");
      process.exit(1);
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
