import { exitWithError } from "../utils/errors";
import type { TaskQueue } from "../queue";
import { loadReports, addReport, updateReportStatus, removeReport } from "../reports";
import { SHORT_ID_LENGTH } from "../task";
import { parseFlags } from "../utils/args";

export async function report(_queue: TaskQueue, args: string[]) {
  if (args[0] === "list") {
    const reports = await loadReports();
    if (reports.length === 0) {
      console.log("No reports.");
      return;
    }
    for (const r of reports) {
      const cat = r.category || "internal";
      console.log(`[${r.status.padEnd(7)}] [${cat}] ${r.title} (by: ${r.createdBy}, ${r.id.slice(0, SHORT_ID_LENGTH)})`);
    }
    return;
  }
  if (args[0] === "show") {
    if (!args[1]) exitWithError("Usage: worqload report show <id>");
    const reports = await loadReports();
    const r = reports.find(rep => rep.id === args[1] || rep.id.startsWith(args[1]));
    if (!r) exitWithError(`Report not found: ${args[1]}`);
    console.log(`# ${r!.title}\n\nStatus: ${r!.status} | By: ${r!.createdBy} | ${r!.createdAt}\n\n${r!.content}`);
    return;
  }
  if (args[0] === "add") {
    const { flags, rest } = parseFlags(args.slice(1), ["--by", "--category"]);
    const title = rest[0];
    const content = rest.slice(1).join(" ");
    if (!title || !content) exitWithError("Usage: worqload report add <title> <content> [--by <creator>] [--category <internal|human>]");
    const category = flags["--category"] as "internal" | "human" | undefined;
    if (category && category !== "internal" && category !== "human") exitWithError(`Invalid category: ${category}. Valid: internal, human`);
    const r = await addReport(title, content, flags["--by"] || "agent", { category });
    console.log(`Report added: ${r.title} (${r.id.slice(0, SHORT_ID_LENGTH)}, ${r.category})`);
    return;
  }
  if (args[0] === "status") {
    if (!args[1] || !args[2]) exitWithError("Usage: worqload report status <id> <unread|reading|read|archived>");
    const valid = ["unread", "reading", "read", "archived"];
    if (!valid.includes(args[2])) exitWithError(`Invalid status: ${args[2]}. Valid: ${valid.join(", ")}`);
    await updateReportStatus(args[1], args[2] as "unread" | "reading" | "read" | "archived");
    console.log(`Report status updated: ${args[2]}`);
    return;
  }
  if (args[0] === "remove") {
    if (!args[1]) exitWithError("Usage: worqload report remove <id>");
    await removeReport(args[1]);
    console.log(`Report removed.`);
    return;
  }
  const reports = await loadReports();
  if (reports.length === 0) {
    console.log("No reports.");
    return;
  }
  for (const r of reports) {
    const cat = r.category || "internal";
    console.log(`[${r.status.padEnd(7)}] [${cat}] ${r.title} (by: ${r.createdBy}, ${r.id.slice(0, SHORT_ID_LENGTH)})`);
  }
}
