// agent-side CLI: `worqload feedback fetch|list`

import { fetchFeedback, fetchFeedbackByFilename, listFeedbackHistory } from "../agent-client";
import { requireEnv, resolveAgentEndpoint, exitWithUsage } from "./cli-helpers";

const USAGE = `worqload feedback fetch [<filename>]
worqload feedback list`;

export async function feedback(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "fetch") {
    await handleFetch(args.slice(1));
  } else if (subcommand === "list") {
    await handleList();
  } else {
    exitWithUsage(USAGE);
  }
}

async function handleFetch(args: string[]): Promise<void> {
  const sessionId = requireEnv("WORQLOAD_SESSION_ID");
  const endpoint = resolveAgentEndpoint();
  const filename = args[0];
  try {
    if (filename) {
      const result = await fetchFeedbackByFilename(endpoint, sessionId, filename);
      console.log(`--- ${result.message.filename} ---`);
      console.log(result.message.content);
    } else {
      const result = await fetchFeedback(endpoint, sessionId);
      if (result.messages.length === 0) return;
      for (const m of result.messages) {
        console.log(`--- ${m.filename} ---`);
        console.log(m.content);
      }
    }
  } catch (err) {
    console.error(`feedback fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function handleList(): Promise<void> {
  const sessionId = requireEnv("WORQLOAD_SESSION_ID");
  const endpoint = resolveAgentEndpoint();
  try {
    const result = await listFeedbackHistory(endpoint, sessionId);
    if (result.messages.length === 0) {
      console.log("(no feedback)");
      return;
    }
    for (const m of result.messages) {
      const firstLine = m.content.split("\n")[0];
      const preview = firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine;
      console.log(`${m.filename}  ${preview}`);
    }
  } catch (err) {
    console.error(`feedback list failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
