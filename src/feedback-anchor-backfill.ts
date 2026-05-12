// Older anchored feedback stored the anchor as a `Re: <path>:<lines>` first
// line in the markdown body; current code keeps it in a `.meta.json` sidecar
// instead and re-derives the `Re:` line only when handing the message to the
// agent. On server start, migrate any leftover `*-anchored.md` whose body still
// leads with that line: write the sidecar and strip the line (plus the one
// blank line after it) from the body. Idempotent — a file that already has a
// sidecar, or whose body no longer leads with the ref, is left untouched.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { metaFilenameFor } from "./file-store";
import { parseAnchorRefLine } from "./anchor-ref";

async function migrateDir(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const filename of entries) {
    if (!filename.endsWith("-anchored.md")) continue;
    if (entries.includes(metaFilenameFor(filename))) continue;
    const path = join(dir, filename);
    const body = await Bun.file(path).text();
    const newlineIdx = body.indexOf("\n");
    const firstLine = newlineIdx === -1 ? body : body.slice(0, newlineIdx);
    const anchor = parseAnchorRefLine(firstLine);
    if (!anchor) continue;
    // postFeedback used to write `Re: ...\n\n<body>`; drop the ref line and the
    // single blank line that followed it.
    let rest = newlineIdx === -1 ? "" : body.slice(newlineIdx + 1);
    if (rest.startsWith("\n")) rest = rest.slice(1);
    await Bun.write(path, rest);
    await Bun.write(join(dir, metaFilenameFor(filename)), JSON.stringify({ anchor }, null, 2));
  }
}

export async function backfillFeedbackAnchors(sessionsDir: string): Promise<void> {
  let sessionIds: string[];
  try {
    sessionIds = await readdir(sessionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const sessionId of sessionIds) {
    await migrateDir(join(sessionsDir, sessionId, "feedback", "inbox"));
    await migrateDir(join(sessionsDir, sessionId, "feedback", "read"));
  }
}
