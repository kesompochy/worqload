// agent-side CLI:
// `worqload report submit --slug <slug> [--re <feedback-filename>] [--image <path>]... [--raw]`
// (body via stdin)
// `worqload report cancel <filename> --reason <text>`

import { basename } from "node:path";
import { submitReport, cancelReport } from "../agent-client";
import { REPORT_POLISH_FORK_ENV } from "../report-polish";
import { readAllStdin, requireEnv, resolveAgentEndpoint, requireFlag, optionalFlag, collectFlag, exitWithUsage } from "./cli-helpers";

const SEPARATOR_LINE = /^[\s\-=*#]*$/;
const KEBAB_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MIN_LENGTH = 20;

export function validateReportBody(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.split("\n").every((line) => SEPARATOR_LINE.test(line))) {
    return "report body contains only separator characters — write the actual content (pass --raw to force)";
  }
  if (KEBAB_SLUG.test(trimmed)) {
    return "report body looks like a slug, not prose — write the actual content (pass --raw to force)";
  }
  if (trimmed.length < MIN_LENGTH) {
    return "report body is too short — write the actual content (pass --raw to force)";
  }
  return null;
}

// Reads each --image path off disk into a File the report POST can upload.
// Bun.file derives the MIME type from the extension; the server has the
// authoritative allow-list and rejects anything that is not an image.
async function loadImages(paths: string[]): Promise<File[]> {
  const images: File[] = [];
  for (const path of paths) {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      console.error(`image not found: ${path}`);
      process.exit(2);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    images.push(new File([bytes], basename(path), { type: file.type }));
  }
  return images;
}

const USAGE =
  "worqload report submit --slug <slug> [--re <feedback-filename>] [--image <path>]... [--raw]  (body via stdin)\n" +
  "       worqload report cancel <filename> --reason <text>";

export async function report(args: string[]): Promise<void> {
  switch (args[0]) {
    case "submit":
      return reportSubmit(args.slice(1));
    case "cancel":
      return reportCancel(args.slice(1));
    default:
      exitWithUsage(USAGE);
  }
}

async function reportSubmit(rest: string[]): Promise<void> {
  if (process.env[REPORT_POLISH_FORK_ENV]) {
    console.error("report submit is disabled while polishing a report: reply with the polished report as text instead");
    process.exit(2);
  }
  const slug = requireFlag(rest, "--slug");
  const replyTo = optionalFlag(rest, "--re");
  const raw = rest.includes("--raw");
  const images = await loadImages(collectFlag(rest, "--image"));
  const content = await readAllStdin();
  if (content.trim() === "") {
    console.error("report body must be provided on stdin");
    process.exit(2);
  }
  if (!raw) {
    const rejection = validateReportBody(content);
    if (rejection) {
      console.error(rejection);
      process.exit(2);
    }
  }
  const sessionId = requireEnv("WORQLOAD_SESSION_ID");
  const endpoint = resolveAgentEndpoint();
  try {
    const result = await submitReport(endpoint, sessionId, slug, content, replyTo, images);
    if ("polishing" in result) {
      console.log(
        "report accepted: worqload is polishing it in a fork of this conversation and stores the polished " +
          "text, or withdraws it when the fork judges it not worth the human's reading.",
      );
    } else {
      console.log(result.filename);
    }
  } catch (err) {
    console.error(`report submit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function reportCancel(args: string[]): Promise<void> {
  const filename = args[0];
  if (filename === undefined || filename.startsWith("--")) exitWithUsage(USAGE);
  const reason = requireFlag(args, "--reason");
  const sessionId = requireEnv("WORQLOAD_SESSION_ID");
  const endpoint = resolveAgentEndpoint();
  try {
    await cancelReport(endpoint, sessionId, filename, reason);
    console.log(`cancelled ${filename}`);
  } catch (err) {
    console.error(`report cancel failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
