// agent-side CLI:
//   `worqload escalate submit --slug <slug>`        (question body via stdin)
//   `worqload escalate command --command "<cmd>"`   (reason via stdin, required)
//   `worqload escalate cancel <filename> [--reason <text>]`
//   `worqload escalate cancel --slug <slug> [--reason <text>]`

import { submitEscalation, cancelEscalation, cancelEscalationBySlug, requestCommandApproval } from "../agent-client";
import { readAllStdin, requireEnv, resolveAgentEndpoint, requireFlag, optionalFlag, exitWithUsage } from "./cli-helpers";

const USAGE =
  "worqload escalate submit --slug <slug>          (question body via stdin)\n" +
  "       worqload escalate command --command <cmd> [--timeout <seconds>]  (reason via stdin, required)\n" +
  "       worqload escalate cancel <filename> [--reason <text>]\n" +
  "       worqload escalate cancel --slug <slug> [--reason <text>]";

export async function escalate(args: string[]): Promise<void> {
  switch (args[0]) {
    case "submit":
      return escalateSubmit(args.slice(1));
    case "command":
      return escalateCommand(args.slice(1));
    case "cancel":
      return escalateCancel(args.slice(1));
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
    if ("polishing" in result) {
      console.log(
        "escalation accepted: worqload is polishing it in a fork of this conversation and shows the polished " +
          "text to the human, or returns it to your feedback inbox with the reason. Its filename is decided " +
          `when it is shown, so cancel it with \`worqload escalate cancel --slug ${slug}\`.`,
      );
    } else {
      console.log(result.filename);
    }
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
  if (reason === "") {
    console.error("reason must be provided on stdin");
    process.exit(2);
  }
  const sessionId = requireEnv("WORQLOAD_SESSION_ID");
  const endpoint = resolveAgentEndpoint();
  try {
    const result = await requestCommandApproval(endpoint, sessionId, command, reason, timeoutSeconds);
    console.log(result.filename);
  } catch (err) {
    console.error(`escalate command failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function escalateCancel(args: string[]): Promise<void> {
  const slug = optionalFlag(args, "--slug");
  const filename = args[0];
  if (slug === undefined && (filename === undefined || filename.startsWith("--"))) exitWithUsage(USAGE);
  const reason = optionalFlag(args, "--reason");
  const sessionId = requireEnv("WORQLOAD_SESSION_ID");
  const endpoint = resolveAgentEndpoint();
  try {
    if (slug !== undefined) {
      await cancelEscalationBySlug(endpoint, sessionId, slug, reason);
      console.log(`cancelled ${slug}`);
    } else {
      await cancelEscalation(endpoint, sessionId, filename!, reason);
      console.log(`cancelled ${filename}`);
    }
  } catch (err) {
    console.error(`escalate cancel failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
