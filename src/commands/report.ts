// agent-side CLI: `worqload report submit --slug <slug> [--re <feedback-filename>]`
// (body via stdin)

import { submitReport } from "../agent-client";
import { readAllStdin, requireEnv, resolveAgentEndpoint, requireFlag, optionalFlag, exitWithUsage } from "./cli-helpers";

export async function report(args: string[]): Promise<void> {
  if (args[0] !== "submit") {
    exitWithUsage("worqload report submit --slug <slug> [--re <feedback-filename>]  (body via stdin)");
  }
  const rest = args.slice(1);
  const slug = requireFlag(rest, "--slug");
  const replyTo = optionalFlag(rest, "--re");
  const content = await readAllStdin();
  if (content.trim() === "") {
    console.error("report body must be provided on stdin");
    process.exit(2);
  }
  const sessionId = requireEnv("WORQLOAD_SESSION_ID");
  const endpoint = resolveAgentEndpoint();
  try {
    const result = await submitReport(endpoint, sessionId, slug, content, replyTo);
    console.log(result.filename);
  } catch (err) {
    console.error(`report submit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
