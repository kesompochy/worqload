// agent-side CLI:
//   `worqload escalate submit --slug <slug>`        (question body via stdin)
//   `worqload escalate command --command "<cmd>"`   (optional reason via stdin)

import { submitEscalation, requestCommandApproval } from "../agent-client";
import { readAllStdin, requireEnv, resolveAgentEndpoint, requireFlag, optionalFlag, exitWithUsage } from "./cli-helpers";

const USAGE =
  "worqload escalate submit --slug <slug>          (question body via stdin)\n" +
  "       worqload escalate command --command <cmd> [--timeout <seconds>]  (optional reason via stdin)";

export async function escalate(args: string[]): Promise<void> {
  switch (args[0]) {
    case "submit":
      return escalateSubmit(args.slice(1));
    case "command":
      return escalateCommand(args.slice(1));
    default:
      exitWithUsage(USAGE);
  }
}

async function escalateSubmit(args: string[]): Promise<void> {
  const slug = requireFlag(args, "--slug");
  const content = await readAllStdin();
  if (content.trim() === "") {
    console.error("escalation body must be provided on stdin");
    process.exit(2);
  }
  const sessionId = requireEnv("WORQLOAD_SESSION_ID");
  const endpoint = resolveAgentEndpoint();
  try {
    const result = await submitEscalation(endpoint, sessionId, slug, content);
    console.log(result.filename);
  } catch (err) {
    console.error(`escalate submit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function escalateCommand(args: string[]): Promise<void> {
  const command = requireFlag(args, "--command");
  if (command.trim() === "") {
    console.error("--command must not be empty");
    process.exit(2);
  }
  const timeoutRaw = optionalFlag(args, "--timeout");
  let timeoutSeconds: number | undefined;
  if (timeoutRaw !== undefined) {
    timeoutSeconds = Number(timeoutRaw);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      console.error("--timeout must be a positive number (seconds)");
      process.exit(2);
    }
  }
  const reason = (await readAllStdin()).trim();
  const sessionId = requireEnv("WORQLOAD_SESSION_ID");
  const endpoint = resolveAgentEndpoint();
  try {
    const result = await requestCommandApproval(endpoint, sessionId, command, reason, true, timeoutSeconds);
    console.log(result.feedbackContent ?? result.filename);
  } catch (err) {
    console.error(`escalate command failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
