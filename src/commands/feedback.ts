import { basename } from "path";
import { exitWithError } from "../utils/errors";
import type { TaskQueue } from "../queue";
import { loadFeedback, addFeedback, acknowledgeFeedback, resolveFeedback, summarizeFeedback, distillFeedback, sendFeedbackToProject } from "../feedback";
import { parseFlags } from "../utils/args";
import { SHORT_ID_LENGTH } from "../task";
import { loadConfig } from "../config";

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
        console.log(`  - ${t.description}`);
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
  if (args[0] === "send") {
    const targetProject = args[1];
    if (!targetProject) {
      exitWithError("Usage: worqload feedback send <project-name> <message> [--from <sender>]");
    }
    const { flags, rest } = parseFlags(args.slice(2), ["--from"]);
    const from = flags["--from"] || basename(process.cwd());
    const message = rest.join(" ").trim();
    if (!message) {
      exitWithError("Usage: worqload feedback send <project-name> <message> [--from <sender>]");
    }
    const fb = await sendFeedbackToProject(targetProject, message, from);
    console.log(`Feedback sent to ${targetProject}: ${fb.message} (from: ${fb.from}, ${fb.id.slice(0, SHORT_ID_LENGTH)})`);
    return;
  }
  if (args[0] === "distill") {
    const config = await loadConfig();
    const templatePath = config.init?.agentPath || ".claude/skills/worqload/SKILL.md";
    const result = await distillFeedback(undefined, templatePath);
    if (result.distilledCount === 0) {
      console.log("No resolved feedback to distill.");
      return;
    }
    console.log(`Distilled ${result.distilledCount} feedback item(s) into Rules:`);
    for (const rule of result.rules) {
      console.log(`  - ${rule}`);
    }
    return;
  }
  const { flags, rest } = parseFlags(args, ["--from"]);
  const from = flags["--from"] || "anonymous";
  const message = rest.join(" ").trim();
  if (!message) {
    exitWithError("Usage: worqload feedback <message> [--from <sender>]");
  }
  if (/^(show|list|ack|resolve|send|distill|summary)\s/i.test(message) || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(message)) {
    exitWithError(`Rejected: "${message.slice(0, 40)}" looks like a CLI subcommand output, not feedback.`);
  }
  const fb = await addFeedback(message, from);
  console.log(`Feedback added: ${fb.message} (from: ${fb.from}, ${fb.id.slice(0, SHORT_ID_LENGTH)})`);
}
