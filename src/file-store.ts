import { mkdir, readdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { withLock } from "./lock";

const READ_STATE_BASENAME = ".read-state.json";

const SLUG_RE = /[^a-zA-Z0-9_-]+/g;
const TRIM_RE = /^-+|-+$/g;
const NUMBER_RE = /^(\d+)-/;

function sanitiseSlug(slug: string): string {
  const cleaned = slug.replace(SLUG_RE, "-").replace(TRIM_RE, "");
  return cleaned === "" ? "untitled" : cleaned;
}

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

async function maxNumberIn(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let max = 0;
  for (const name of entries) {
    const m = name.match(NUMBER_RE);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

async function nextNumber(dir: string, archiveDirs: string[]): Promise<number> {
  let max = await maxNumberIn(dir);
  for (const archiveDir of archiveDirs) {
    const n = await maxNumberIn(archiveDir);
    if (n > max) max = n;
  }
  return max + 1;
}

export interface NumberedFile {
  filename: string;
  seq: number;
  path: string;
}

// Structured side data for a numbered file, kept in a `<base>.meta.json` sidecar
// next to the `.md` (same spirit as the `.read-state.json` sidecar). Keeping it
// out of the markdown body means the body stays clean for both the human's eyes
// and the agent's `worqload feedback fetch`; callers that still want a textual
// cue (e.g. the `Re:` line the agent reads) re-derive it from this.
export interface NumberedFileMeta {
  // The diff/file/report line a piece of feedback (or a report) is anchored to.
  anchor?: { path: string; lineStart: number; lineEnd: number };
  // For a report: the filename of the feedback message it answers.
  replyTo?: string;
}

export function metaFilenameFor(mdFilename: string): string {
  return mdFilename.replace(/\.md$/, ".meta.json");
}

// Sibling directory holding raw attachments (e.g. images pasted into the
// feedback composer) for a numbered .md file. Same naming convention as the
// .meta.json sidecar so the .md, the meta, and the attachments stay grouped.
export function attachmentsDirNameFor(mdFilename: string): string {
  return mdFilename.replace(/\.md$/, ".attachments");
}

function isEmptyMeta(meta: NumberedFileMeta): boolean {
  return Object.values(meta).every(v => v === undefined);
}

export interface AttachmentInput {
  // The on-disk filename inside `<base>.attachments/`. Callers are expected to
  // hand over already-deduplicated names (the feedback POST handler prefixes
  // each upload with a numeric counter to keep them collision-free).
  name: string;
  bytes: Uint8Array | ArrayBuffer | Blob;
}

export interface WriteNumberedFileOptions {
  // Directories that hold files previously archived out of `dir` (e.g. a
  // drained feedback "inbox" whose messages were moved to "read"). Their
  // filenames count toward the next number so the sequence stays monotonic
  // across the whole lifecycle instead of resetting once `dir` empties.
  archiveDirs?: string[];
  // Structured side data written to a `<base>.meta.json` sidecar. Omitted (or
  // empty) means no sidecar is created.
  meta?: NumberedFileMeta;
  // Files written into a sibling `<base>.attachments/` directory. Omitted or
  // empty means no directory is created.
  attachments?: AttachmentInput[];
}

export async function writeNumberedFile(
  dir: string,
  slug: string,
  content: string,
  options: WriteNumberedFileOptions = {},
): Promise<NumberedFile> {
  const archiveDirs = options.archiveDirs ?? [];
  // Lock on the directory itself so concurrent writes get unique seq numbers.
  const lockKey = join(dir, ".numbering");
  await mkdir(dir, { recursive: true });
  return withLock(lockKey, async () => {
    const seq = await nextNumber(dir, archiveDirs);
    const filename = `${pad(seq)}-${sanitiseSlug(slug)}.md`;
    const path = join(dir, filename);
    await Bun.write(path, content);
    if (options.meta && !isEmptyMeta(options.meta)) {
      await Bun.write(join(dir, metaFilenameFor(filename)), JSON.stringify(options.meta, null, 2));
    }
    if (options.attachments && options.attachments.length > 0) {
      const attachDir = join(dir, attachmentsDirNameFor(filename));
      await mkdir(attachDir, { recursive: true });
      for (const att of options.attachments) {
        await Bun.write(join(attachDir, att.name), att.bytes);
      }
    }
    return { filename, seq, path };
  });
}

export interface ReadFile {
  filename: string;
  content: string;
  path: string;
  meta?: NumberedFileMeta;
  // Sorted names found inside the sibling `<base>.attachments/` dir, omitted
  // when the dir is missing or empty.
  attachments?: string[];
}

async function readMetaSidecar(dir: string, mdFilename: string): Promise<NumberedFileMeta | undefined> {
  const file = Bun.file(join(dir, metaFilenameFor(mdFilename)));
  if (!(await file.exists())) return undefined;
  try {
    const data = await file.json() as NumberedFileMeta;
    return data && !isEmptyMeta(data) ? data : undefined;
  } catch {
    return undefined;  // corrupt sidecar: treat as absent
  }
}

async function listAttachments(dir: string, mdFilename: string): Promise<string[] | undefined> {
  const attachDir = join(dir, attachmentsDirNameFor(mdFilename));
  let entries: string[];
  try {
    entries = await readdir(attachDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  if (entries.length === 0) return undefined;
  return entries.sort();
}

export async function listAllFiles(dir: string): Promise<ReadFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files = entries.filter(e => e.endsWith(".md")).sort();
  const result: ReadFile[] = [];
  for (const filename of files) {
    const path = join(dir, filename);
    const content = await Bun.file(path).text();
    const meta = await readMetaSidecar(dir, filename);
    const attachments = await listAttachments(dir, filename);
    const entry: ReadFile = { filename, content, path };
    if (meta) entry.meta = meta;
    if (attachments) entry.attachments = attachments;
    result.push(entry);
  }
  return result;
}

export async function moveFile(srcPath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  await rename(srcPath, destPath);
}

// Moves a numbered file together with its `.meta.json` sidecar and
// `.attachments/` directory (when each is present), keeping the filename. Used
// to archive a drained feedback inbox into the "read" directory.
export async function moveNumberedFile(srcDir: string, destDir: string, filename: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await rename(join(srcDir, filename), join(destDir, filename));
  const metaName = metaFilenameFor(filename);
  if (await Bun.file(join(srcDir, metaName)).exists()) {
    await rename(join(srcDir, metaName), join(destDir, metaName));
  }
  const attachDirName = attachmentsDirNameFor(filename);
  const srcAttachDir = join(srcDir, attachDirName);
  if (existsSync(srcAttachDir)) {
    await rename(srcAttachDir, join(destDir, attachDirName));
  }
}

function readStatePath(dir: string): string {
  return join(dir, READ_STATE_BASENAME);
}

export async function readReadState(dir: string): Promise<Set<string>> {
  const file = Bun.file(readStatePath(dir));
  if (!(await file.exists())) return new Set();
  try {
    const data = await file.json() as { read?: string[] };
    return new Set(data.read ?? []);
  } catch {
    return new Set();
  }
}

export async function setReadState(
  dir: string,
  filename: string,
  read: boolean,
): Promise<void> {
  const path = readStatePath(dir);
  await mkdir(dir, { recursive: true });
  await withLock(path, async () => {
    const current = await readReadState(dir);
    if (read) current.add(filename);
    else current.delete(filename);
    await Bun.write(path, JSON.stringify({ read: [...current].sort() }, null, 2));
  });
}

// Marks every `.md` file in `dir` as read in one pass and returns the filenames
// that were not already read. A no-op (returns []) when the directory has no
// files, so it never creates the directory or a read-state sidecar for nothing.
export async function markAllRead(dir: string): Promise<string[]> {
  const files = await listAllFiles(dir);
  if (files.length === 0) return [];
  const path = readStatePath(dir);
  return withLock(path, async () => {
    const current = await readReadState(dir);
    const newlyRead = files.map(f => f.filename).filter(name => !current.has(name));
    if (newlyRead.length === 0) return [];
    for (const name of newlyRead) current.add(name);
    await Bun.write(path, JSON.stringify({ read: [...current].sort() }, null, 2));
    return newlyRead;
  });
}
