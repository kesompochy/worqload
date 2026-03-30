import { exitWithError } from "../utils/errors";
import type { TaskQueue } from "../queue";
import { loadFeedback, addFeedback, acknowledgeFeedback, resolveFeedback, summarizeFeedback } from "../feedback";
import { parseFlags } from "../utils/args";
import { SHORT_ID_LENGTH } from "../task";

export async function feedback(_queue: TaskQueue, args: string[]) {
  if (args[0] === "summary") {
    const items = await loadFeedback();
    const summary = summarizeFeedback(items);
    console.log("--- Feedback Summary ---");
    console.log(`new: ${summary.counts.new}  acknowledged: ${summary.counts.acknowledged}  resolved: ${summary.counts.resolved}`);
    if (summary.recentUnresolved.length > 0) {
      console.log("\nRecent unresolved:");
      for (const f of summary.recentUnresolved) {
        console.log(`  [${f.status}] ${f.message} (from: ${f.from})`);
      }
    }
    if (summary.themes.length > 0) {
      console.log("\nThemes:");
      for (const t of summary.themes) {
        console.log(`  - ${t}`);
      }
    }
    return;
  }
  if (args[0] === "list") {
    const items = await loadFeedback();
    if (items.length === 0) {
      console.log("No feedback.");
      return;
    }
    for (const f of items) {
      console.log(`[${f.status.padEnd(12)}] ${f.message} (from: ${f.from}, ${f.id.slice(0, SHORT_ID_LENGTH)})`);
    }
    return;
  }
  if (args[0] === "ack") {
    await acknowledgeFeedback(args[1]);
    console.log("Acknowledged.");
    return;
  }
  if (args[0] === "resolve") {
    await resolveFeedback(args[1]);
    console.log("Resolved.");
    return;
  }
  const { flags, rest } = parseFlags(args, ["--from"]);
  const from = flags["--from"] || "anonymous";
  const message = rest.join(" ").trim();
  if (!message) {
    exitWithError("Usage: worqload feedback <message> [--from <sender>]");
  }
  const fb = await addFeedback(message, from);
  console.log(`Feedback added: ${fb.message} (from: ${fb.from}, ${fb.id.slice(0, SHORT_ID_LENGTH)})`);
}
