import { test, expect, afterEach } from "bun:test";
import { join } from "path";
import { existsSync } from "fs";
import { writeNumberedFile, listAllFiles, moveFile, moveNumberedFile, deleteNumberedFile, metaFilenameFor, attachmentsDirNameFor, readReadState, setReadState, markAllRead } from "./file-store";
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

test("writeNumberedFile continues past files archived out of the directory", async () => {
  const root = makeTmpDir("file-store");
  const inbox = join(root, "inbox");
  const archive = join(root, "read");
  const a = await writeNumberedFile(inbox, "a", "alpha");
  await moveFile(join(inbox, a.filename), join(archive, a.filename));

  // inbox is now empty, but numbering must not reset to 001.
  const b = await writeNumberedFile(inbox, "b", "beta", { archiveDirs: [archive] });
  expect(b.filename).toBe("002-b.md");
  expect(b.seq).toBe(2);
});

test("writeNumberedFile tolerates a missing archive dir", async () => {
  const root = makeTmpDir("file-store");
  const r = await writeNumberedFile(join(root, "inbox"), "a", "alpha", {
    archiveDirs: [join(root, "never-created")],
  });
  expect(r.filename).toBe("001-a.md");
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

test("markAllRead marks every file read and returns the newly-read ones", async () => {
  const dir = makeTmpDir("file-store");
  await writeNumberedFile(dir, "a", "alpha");
  await writeNumberedFile(dir, "b", "beta");
  await writeNumberedFile(dir, "c", "gamma");
  await setReadState(dir, "002-b.md", true);

  const newlyRead = await markAllRead(dir);

  expect(newlyRead.sort()).toEqual(["001-a.md", "003-c.md"]);
  const set = await readReadState(dir);
  expect([...set].sort()).toEqual(["001-a.md", "002-b.md", "003-c.md"]);
});

test("markAllRead returns empty when every file is already read", async () => {
  const dir = makeTmpDir("file-store");
  await writeNumberedFile(dir, "a", "alpha");
  await setReadState(dir, "001-a.md", true);
  expect(await markAllRead(dir)).toEqual([]);
});

test("markAllRead returns empty for a missing directory", async () => {
  const dir = makeTmpDir("file-store");
  expect(await markAllRead(join(dir, "missing"))).toEqual([]);
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

test("writeNumberedFile writes a .meta.json sidecar and listAllFiles reads it back", async () => {
  const dir = makeTmpDir("file-store");
  const anchor = { path: "src/foo.ts", lineStart: 3, lineEnd: 7 };
  const { filename } = await writeNumberedFile(dir, "msg", "the body", { meta: { anchor } });

  expect(filename).toBe("001-msg.md");
  expect(existsSync(join(dir, "001-msg.meta.json"))).toBe(true);

  const files = await listAllFiles(dir);
  expect(files).toHaveLength(1);
  expect(files[0].content).toBe("the body");
  expect(files[0].meta).toEqual({ anchor });
});

test("writeNumberedFile writes no sidecar when meta is omitted or empty", async () => {
  const dir = makeTmpDir("file-store");
  await writeNumberedFile(dir, "a", "body");
  await writeNumberedFile(dir, "b", "body", { meta: {} });

  expect(existsSync(join(dir, "001-a.meta.json"))).toBe(false);
  expect(existsSync(join(dir, "002-b.meta.json"))).toBe(false);
  const files = await listAllFiles(dir);
  expect(files.every(f => f.meta === undefined)).toBe(true);
});

test("listAllFiles ignores .meta.json sidecars as standalone entries", async () => {
  const dir = makeTmpDir("file-store");
  await writeNumberedFile(dir, "msg", "body", { meta: { anchor: { path: "p", lineStart: 1, lineEnd: 1 } } });
  const files = await listAllFiles(dir);
  expect(files.map(f => f.filename)).toEqual(["001-msg.md"]);
});

test("moveNumberedFile relocates the file and its sidecar", async () => {
  const dir = makeTmpDir("file-store");
  const inbox = join(dir, "inbox");
  const read = join(dir, "read");
  const { filename } = await writeNumberedFile(inbox, "msg", "hello", { meta: { anchor: { path: "p", lineStart: 2, lineEnd: 2 } } });

  await moveNumberedFile(inbox, read, filename);

  expect(existsSync(join(inbox, filename))).toBe(false);
  expect(existsSync(join(inbox, metaFilenameFor(filename)))).toBe(false);
  expect(existsSync(join(read, filename))).toBe(true);
  expect(existsSync(join(read, metaFilenameFor(filename)))).toBe(true);
});

test("moveNumberedFile tolerates a missing sidecar", async () => {
  const dir = makeTmpDir("file-store");
  const inbox = join(dir, "inbox");
  const read = join(dir, "read");
  const { filename } = await writeNumberedFile(inbox, "msg", "hello");

  await moveNumberedFile(inbox, read, filename);

  expect(existsSync(join(read, filename))).toBe(true);
  expect(existsSync(join(read, metaFilenameFor(filename)))).toBe(false);
});

test("writeNumberedFile writes attachments to a sibling .attachments dir", async () => {
  const dir = makeTmpDir("file-store");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const txt = new Uint8Array([0x68, 0x69]);
  const { filename } = await writeNumberedFile(dir, "msg", "the body", {
    attachments: [
      { name: "01-screenshot.png", bytes: png },
      { name: "02-note.png", bytes: txt },
    ],
  });

  expect(filename).toBe("001-msg.md");
  const attachDir = join(dir, attachmentsDirNameFor(filename));
  expect(existsSync(attachDir)).toBe(true);
  expect(new Uint8Array(await Bun.file(join(attachDir, "01-screenshot.png")).arrayBuffer())).toEqual(png);
  expect(new Uint8Array(await Bun.file(join(attachDir, "02-note.png")).arrayBuffer())).toEqual(txt);
});

test("writeNumberedFile creates no attachments dir when option is omitted or empty", async () => {
  const dir = makeTmpDir("file-store");
  await writeNumberedFile(dir, "a", "body");
  await writeNumberedFile(dir, "b", "body", { attachments: [] });

  expect(existsSync(join(dir, attachmentsDirNameFor("001-a.md")))).toBe(false);
  expect(existsSync(join(dir, attachmentsDirNameFor("002-b.md")))).toBe(false);
});

test("listAllFiles surfaces attachment names sorted; absent attachments leave the field undefined", async () => {
  const dir = makeTmpDir("file-store");
  await writeNumberedFile(dir, "withatt", "body", {
    attachments: [
      { name: "02-b.png", bytes: new Uint8Array([1]) },
      { name: "01-a.png", bytes: new Uint8Array([2]) },
    ],
  });
  await writeNumberedFile(dir, "plain", "body");

  const files = await listAllFiles(dir);
  const byName = Object.fromEntries(files.map(f => [f.filename, f]));
  expect(byName["001-withatt.md"].attachments).toEqual(["01-a.png", "02-b.png"]);
  expect(byName["002-plain.md"].attachments).toBeUndefined();
});

test("moveNumberedFile relocates the attachments dir along with the file", async () => {
  const dir = makeTmpDir("file-store");
  const inbox = join(dir, "inbox");
  const read = join(dir, "read");
  const { filename } = await writeNumberedFile(inbox, "msg", "hello", {
    attachments: [{ name: "01-image.png", bytes: new Uint8Array([0x89]) }],
  });

  await moveNumberedFile(inbox, read, filename);

  const srcAttach = join(inbox, attachmentsDirNameFor(filename));
  const dstAttach = join(read, attachmentsDirNameFor(filename));
  expect(existsSync(srcAttach)).toBe(false);
  expect(existsSync(dstAttach)).toBe(true);
  expect(existsSync(join(dstAttach, "01-image.png"))).toBe(true);
});

test("moveNumberedFile tolerates a missing attachments dir", async () => {
  const dir = makeTmpDir("file-store");
  const inbox = join(dir, "inbox");
  const read = join(dir, "read");
  const { filename } = await writeNumberedFile(inbox, "msg", "hello");

  await moveNumberedFile(inbox, read, filename);

  expect(existsSync(join(read, filename))).toBe(true);
  expect(existsSync(join(read, attachmentsDirNameFor(filename)))).toBe(false);
});

test("deleteNumberedFile removes the file, its sidecar, its attachments, and the read-state entry", async () => {
  const dir = makeTmpDir("file-store");
  const { filename } = await writeNumberedFile(dir, "msg", "body", {
    meta: { anchor: { path: "p", lineStart: 1, lineEnd: 1 } },
    attachments: [{ name: "01-image.png", bytes: new Uint8Array([0x89]) }],
  });
  await writeNumberedFile(dir, "keep", "still here");
  await setReadState(dir, filename, true);

  await deleteNumberedFile(dir, filename);

  expect(existsSync(join(dir, filename))).toBe(false);
  expect(existsSync(join(dir, metaFilenameFor(filename)))).toBe(false);
  expect(existsSync(join(dir, attachmentsDirNameFor(filename)))).toBe(false);
  expect((await readReadState(dir)).has(filename)).toBe(false);
  expect((await listAllFiles(dir)).map(f => f.filename)).toEqual(["002-keep.md"]);
});

test("deleteNumberedFile tolerates a file without sidecar, attachments, or read-state", async () => {
  const dir = makeTmpDir("file-store");
  const { filename } = await writeNumberedFile(dir, "msg", "body");

  await deleteNumberedFile(dir, filename);

  expect(existsSync(join(dir, filename))).toBe(false);
});
