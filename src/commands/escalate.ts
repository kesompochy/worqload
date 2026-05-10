// agent-side CLI: `worqload escalate submit --slug <slug>` (body via stdin)

import { submitEscalation } from "../agent-client";
import { readAllStdin, requireEnv, requireFlag, exitWithUsage } from "./cli-helpers";

export async function escalate(args: string[]): Promise<void> {
  if (args[0] !== "submit") {
    exitWithUsage("worqload escalate submit --slug <slug>  (body via stdin)");
  }
  const slug = requireFlag(args.slice(1), "--slug");
  const content = await readAllStdin();
  if (content.trim() === "") {
    console.error("escalation body must be provided on stdin");
    process.exit(2);
  }
  const sessionId = requireEnv("WORQLOAD_SESSION_ID");
  const endpoint = requireEnv("WORQLOAD_ENDPOINT");
  try {
    const result = await submitEscalation(endpoint, sessionId, slug, content);
    console.log(result.filename);
  } catch (err) {
    console.error(`escalate submit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
