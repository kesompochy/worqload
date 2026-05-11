import { mkdir, readdir, rename } from "node:fs/promises";
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

export interface WriteNumberedFileOptions {
  // Directories that hold files previously archived out of `dir` (e.g. a
  // drained feedback "inbox" whose messages were moved to "read"). Their
  // filenames count toward the next number so the sequence stays monotonic
  // across the whole lifecycle instead of resetting once `dir` empties.
  archiveDirs?: string[];
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
    return { filename, seq, path };
  });
}

export interface ReadFile {
  filename: string;
  content: string;
  path: string;
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
    result.push({ filename, content, path });
  }
  return result;
}

export async function moveFile(srcPath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  await rename(srcPath, destPath);
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
