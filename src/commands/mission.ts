import { exitWithError } from "../utils/errors";
import type { TaskQueue } from "../queue";
import { loadMissions, createMission, completeMission } from "../mission";
import { SHORT_ID_LENGTH } from "../task";
import { parseFlags } from "../utils/args";

export async function mission(queue: TaskQueue, args: string[]) {
  if (args[0] === "create") {
    const { flags, rest } = parseFlags(args.slice(1), ["--filter"]);
    const name = rest[0];
    if (!name) exitWithError("Usage: worqload mission create <name> [--filter tags:a,b]");
    const filter: { tags?: string[] } = {};
    if (flags["--filter"]) {
      const filterStr = flags["--filter"];
      if (filterStr.startsWith("tags:")) {
        filter.tags = filterStr.slice(5).split(",").map(t => t.trim());
      }
    }
    const m = await createMission(name, filter);
    console.log(`Mission created: ${m.name} (${m.id.slice(0, SHORT_ID_LENGTH)})`);
    return;
  }
  if (args[0] === "list") {
    const missions = await loadMissions();
    if (missions.length === 0) {
      console.log("No missions.");
      return;
    }
    for (const m of missions) {
      const tags = m.filter.tags ? ` [${m.filter.tags.join(",")}]` : "";
      const taskCount = queue.getByMission(m.id).length;
      console.log(`[${m.status.padEnd(9)}] ${m.name}${tags} (tasks: ${taskCount}, ${m.id.slice(0, SHORT_ID_LENGTH)})`);
    }
    return;
  }
  if (args[0] === "assign") {
    if (!args[1] || !args[2]) exitWithError("Usage: worqload mission assign <mission-id> <task-id>");
    const missions = await loadMissions();
    const m = missions.find(mi => mi.id === args[1] || mi.id.startsWith(args[1]));
    if (!m) exitWithError(`Mission not found: ${args[1]}`);
    const task = queue.findById(args[2]);
    if (!task) exitWithError(`Task not found: ${args[2]}`);
    queue.update(task!.id, { missionId: m!.id });
    await queue.save();
    console.log(`Task ${task!.id.slice(0, SHORT_ID_LENGTH)} assigned to mission "${m!.name}"`);
    return;
  }
  if (args[0] === "complete") {
    if (!args[1]) exitWithError("Usage: worqload mission complete <mission-id>");
    await completeMission(args[1]);
    console.log("Mission completed.");
    return;
  }
  // Default: list
  const missions = await loadMissions();
  if (missions.length === 0) {
    console.log("No missions.");
    return;
  }
  for (const m of missions) {
    const tags = m.filter.tags ? ` [${m.filter.tags.join(",")}]` : "";
    const taskCount = queue.getByMission(m.id).length;
    console.log(`[${m.status.padEnd(9)}] ${m.name}${tags} (tasks: ${taskCount}, ${m.id.slice(0, SHORT_ID_LENGTH)})`);
  }
}
