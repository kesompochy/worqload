import type { TaskQueue } from "../queue";
import { loadFeedback, addFeedback, acknowledgeFeedback, resolveFeedback } from "../feedback";

export async function feedback(_queue: TaskQueue, args: string[]) {
  if (args[0] === "list") {
    const items = await loadFeedback();
    if (items.length === 0) {
      console.log("No feedback.");
      return;
    }
    for (const f of items) {
      console.log(`[${f.status.padEnd(12)}] ${f.message} (from: ${f.from}, ${f.id.slice(0, 8)})`);
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
  let from = "anonymous";
  const msgParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && i + 1 < args.length) {
      from = args[i + 1];
      i++;
    } else {
      msgParts.push(args[i]);
    }
  }
  const message = msgParts.join(" ").trim();
  if (!message) {
    console.error("Usage: worqload feedback <message> [--from <sender>]");
    process.exit(1);
  }
  const fb = await addFeedback(message, from);
  console.log(`Feedback added: ${fb.message} (from: ${fb.from}, ${fb.id.slice(0, 8)})`);
}
