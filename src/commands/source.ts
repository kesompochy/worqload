import type { TaskQueue } from "../queue";
import { loadSources, addSource, removeSource, runAllSources } from "../sources";

export async function source(_queue: TaskQueue, args: string[]) {
  if (args[0] === "add") {
    const name = args[1];
    const command = args.slice(2).join(" ");
    if (!name || !command) {
      console.error("Usage: worqload source add <name> <command>");
      process.exit(1);
    }
    await addSource({ name, type: "shell", command });
    console.log(`Source added: ${name} → ${command}`);
    return;
  }
  if (args[0] === "remove") {
    const name = args[1];
    if (!name) {
      console.error("Usage: worqload source remove <name>");
      process.exit(1);
    }
    await removeSource(name);
    console.log(`Source removed: ${name}`);
    return;
  }
  if (args[0] === "run") {
    const results = await runAllSources();
    if (results.length === 0) {
      console.log("No sources registered.");
      return;
    }
    for (const r of results) {
      console.log(`--- ${r.name} (exit: ${r.exitCode}) ---`);
      console.log(r.output);
      console.log();
    }
    return;
  }
  const sources = await loadSources();
  if (sources.length === 0) {
    console.log("No sources registered.");
    console.log("Usage: worqload source add <name> <command>");
    return;
  }
  for (const s of sources) {
    console.log(`  ${s.name}: ${s.command}`);
  }
}
