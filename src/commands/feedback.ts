// agent-side CLI: `worqload feedback fetch`

import { fetchFeedback } from "../agent-client";
import { requireEnv, resolveAgentEndpoint, exitWithUsage } from "./cli-helpers";

export async function feedback(args: string[]): Promise<void> {
  if (args[0] !== "fetch") {
    exitWithUsage("worqload feedback fetch");
  }
  const sessionId = requireEnv("WORQLOAD_SESSION_ID");
  const endpoint = resolveAgentEndpoint();
  try {
    const result = await fetchFeedback(endpoint, sessionId);
    if (result.messages.length === 0) {
      // empty inbox: print nothing, exit 0
      return;
    }
    for (const m of result.messages) {
      console.log(`--- ${m.filename} ---`);
      console.log(m.content);
    }
  } catch (err) {
    console.error(`feedback fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
