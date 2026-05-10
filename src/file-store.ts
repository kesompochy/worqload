import { mkdir, readdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { withLock } from "./lock";

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

async function nextNumber(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 1;
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
  return max + 1;
}

export interface NumberedFile {
  filename: string;
  seq: number;
  path: string;
}

export async function writeNumberedFile(
  dir: string,
  slug: string,
  content: string,
): Promise<NumberedFile> {
  // Lock on the directory itself so concurrent writes get unique seq numbers.
  const lockKey = join(dir, ".numbering");
  await mkdir(dir, { recursive: true });
  return withLock(lockKey, async () => {
    const seq = await nextNumber(dir);
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
