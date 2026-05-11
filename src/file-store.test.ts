import { test, expect, afterEach } from "bun:test";
import { join } from "path";
import { existsSync } from "fs";
import { writeNumberedFile, listAllFiles, moveFile, readReadState, setReadState } from "./file-store";
import { makeTmpDir, cleanupAll } from "./test-helpers";

afterEach(cleanupAll);

test("writeNumberedFile starts at 001 and increments", async () => {
  const dir = makeTmpDir("file-store");
  const a = await writeNumberedFile(dir, "first", "body A");
  const b = await writeNumberedFile(dir, "second", "body B");
  const c = await writeNumberedFile(dir, "third", "body C");

  expect(a.filename).toBe("001-first.md");
  expect(b.filename).toBe("002-second.md");
  expect(c.filename).toBe("003-third.md");
  expect(a.seq).toBe(1);
  expect(c.seq).toBe(3);
});

test("writeNumberedFile sanitises slug to safe chars", async () => {
  const dir = makeTmpDir("file-store");
  const r = await writeNumberedFile(dir, "Hello World / Build 失敗", "body");
  expect(r.filename).toMatch(/^001-Hello-World-Build.*\.md$/);
});

test("writeNumberedFile creates the directory if missing", async () => {
  const dir = makeTmpDir("file-store");
  const sub = join(dir, "sub", "deep");
  expect(existsSync(sub)).toBe(false);
  await writeNumberedFile(sub, "first", "body");
  expect(existsSync(sub)).toBe(true);
});

test("writeNumberedFile concurrent calls produce unique sequential seq", async () => {
  const dir = makeTmpDir("file-store");
  const N = 10;
  const promises = Array.from({ length: N }, (_, i) =>
    writeNumberedFile(dir, `slug${i}`, `body${i}`),
  );
  const results = await Promise.all(promises);
  const seqs = results.map(r => r.seq).sort((a, b) => a - b);
  expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
});

test("listAllFiles returns entries sorted by filename", async () => {
  const dir = makeTmpDir("file-store");
  await writeNumberedFile(dir, "a", "alpha");
  await writeNumberedFile(dir, "b", "beta");

  const files = await listAllFiles(dir);
  expect(files).toHaveLength(2);
  expect(files[0].filename).toBe("001-a.md");
  expect(files[0].content).toBe("alpha");
  expect(files[1].filename).toBe("002-b.md");
});

test("listAllFiles returns empty when directory missing", async () => {
  const dir = makeTmpDir("file-store");
  const files = await listAllFiles(join(dir, "missing"));
  expect(files).toEqual([]);
});

test("readReadState returns empty when no state file exists", async () => {
  const dir = makeTmpDir("file-store");
  const set = await readReadState(dir);
  expect(set.size).toBe(0);
});

test("setReadState true then read returns the filename in the set", async () => {
  const dir = makeTmpDir("file-store");
  await writeNumberedFile(dir, "first", "body");
  await setReadState(dir, "001-first.md", true);
  const set = await readReadState(dir);
  expect(set.has("001-first.md")).toBe(true);
});

test("setReadState false removes a previously-read filename", async () => {
  const dir = makeTmpDir("file-store");
  await setReadState(dir, "001-foo.md", true);
  await setReadState(dir, "002-bar.md", true);
  await setReadState(dir, "001-foo.md", false);
  const set = await readReadState(dir);
  expect(set.has("001-foo.md")).toBe(false);
  expect(set.has("002-bar.md")).toBe(true);
});

test("listAllFiles ignores the .read-state.json sidecar", async () => {
  const dir = makeTmpDir("file-store");
  await writeNumberedFile(dir, "a", "alpha");
  await setReadState(dir, "001-a.md", true);
  const files = await listAllFiles(dir);
  expect(files).toHaveLength(1);
  expect(files[0].filename).toBe("001-a.md");
});

test("moveFile relocates a file", async () => {
  const dir = makeTmpDir("file-store");
  const inbox = join(dir, "inbox");
  const read = join(dir, "read");
  const { filename } = await writeNumberedFile(inbox, "msg", "hello");

  await moveFile(join(inbox, filename), join(read, filename));

  expect(existsSync(join(inbox, filename))).toBe(false);
  expect(existsSync(join(read, filename))).toBe(true);
});
