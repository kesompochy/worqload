// agent-side CLI:
// `worqload report submit --slug <slug> [--re <feedback-filename>] [--image <path>]... [--raw]`
// (body via stdin)

import { basename } from "node:path";
import { submitReport } from "../agent-client";
import { readAllStdin, requireEnv, resolveAgentEndpoint, requireFlag, optionalFlag, collectFlag, exitWithUsage } from "./cli-helpers";

const CJK_RANGE = /[　-鿿＀-￯]/;
const SEPARATOR_LINE = /^[\s\-=*#]*$/;
const KEBAB_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateReportBody(body: string): string | null {
  const trimmed = body.trim();
  if (CJK_RANGE.test(trimmed)) return null;
  if (trimmed.split("\n").every((line) => SEPARATOR_LINE.test(line))) {
    return "report body contains only separator characters — write the actual content";
  }
  if (KEBAB_SLUG.test(trimmed)) {
    return "report body looks like a slug, not prose — write the actual content";
  }
  if (trimmed.length < 30) {
    return "report body is too short — write the actual content";
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

export async function report(args: string[]): Promise<void> {
  if (args[0] !== "submit") {
    exitWithUsage("worqload report submit --slug <slug> [--re <feedback-filename>] [--image <path>]... [--raw]  (body via stdin)");
  }
  const rest = args.slice(1);
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
    if ("revisionRequested" in result) {
      console.log(
        "report held for a revision pass and not yet stored: revise mode is on for this session. worqload " +
          "saved your draft to a scratch file and queued the instruction in your feedback inbox — run " +
          "`worqload feedback fetch` for the draft path, edit it in place, and resubmit it. The next " +
          "submission is stored.",
      );
    } else {
      console.log(result.filename);
    }
  } catch (err) {
    console.error(`report submit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
