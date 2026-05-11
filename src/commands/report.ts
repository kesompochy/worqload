// agent-side CLI: `worqload report submit --slug <slug>` (body via stdin)

import { submitReport } from "../agent-client";
import { readAllStdin, requireEnv, resolveAgentEndpoint, requireFlag, exitWithUsage } from "./cli-helpers";

export async function report(args: string[]): Promise<void> {
  if (args[0] !== "submit") {
    exitWithUsage("worqload report submit --slug <slug>  (body via stdin)");
  }
  const slug = requireFlag(args.slice(1), "--slug");
  const content = await readAllStdin();
  if (content.trim() === "") {
    console.error("report body must be provided on stdin");
    process.exit(2);
  }
  const sessionId = requireEnv("WORQLOAD_SESSION_ID");
  const endpoint = resolveAgentEndpoint();
  try {
    const result = await submitReport(endpoint, sessionId, slug, content);
    console.log(result.filename);
  } catch (err) {
    console.error(`report submit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
