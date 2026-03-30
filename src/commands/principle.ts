import { loadPrinciples, savePrinciples } from "../principles";
import type { TaskQueue } from "../queue";

export async function principle(_queue: TaskQueue, args: string[]) {
  if (args[0] === "remove") {
    const index = Number(args[1]);
    const content = await loadPrinciples();
    const lines = content.split("\n").filter(l => l.startsWith("- "));
    if (!Number.isInteger(index) || index < 1 || index > lines.length) {
      console.error(`Invalid index: ${args[1]}. Valid range: 1-${lines.length}`);
      process.exit(1);
    }
    lines.splice(index - 1, 1);
    const updated = lines.length > 0 ? `# Principles\n\n${lines.join("\n")}` : "";
    await savePrinciples(updated);
    console.log(`Principle removed (#${index}).`);
    return;
  }
  if (args[0] === "edit") {
    const index = Number(args[1]);
    const content = await loadPrinciples();
    const lines = content.split("\n").filter(l => l.startsWith("- "));
    if (!Number.isInteger(index) || index < 1 || index > lines.length) {
      console.error(`Invalid index: ${args[1]}. Valid range: 1-${lines.length}`);
      process.exit(1);
    }
    const newText = args.slice(2).join(" ").trim();
    if (!newText) {
      console.error("Usage: worqload principle edit <N> <new text>");
      process.exit(1);
    }
    lines[index - 1] = `- ${newText}`;
    await savePrinciples(`# Principles\n\n${lines.join("\n")}`);
    console.log(`Principle updated (#${index}): ${newText}`);
    return;
  }
  if (args.length === 0) {
    const content = await loadPrinciples();
    if (!content) {
      console.log("No principles defined.");
      console.log("Usage: worqload principle <text to append>");
    } else {
      const lines = content.split("\n").filter(l => l.startsWith("- "));
      console.log("# Principles\n");
      for (let i = 0; i < lines.length; i++) {
        console.log(`${i + 1}. ${lines[i].slice(2)}`);
      }
    }
    return;
  }
  const current = await loadPrinciples();
  const newLine = args.join(" ");
  const updated = current ? `${current}\n- ${newLine}` : `# Principles\n\n- ${newLine}`;
  await savePrinciples(updated);
  console.log(`Principle added: ${newLine}`);
}
