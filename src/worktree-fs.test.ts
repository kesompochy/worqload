import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, existsSync, writeFileSync, readFileSync, symlinkSync } from "fs";
import { makeTmpDir } from "./test-helpers";
import {
  readWorktreeFile,
  writeWorktreeFile,
  createWorktreeFile,
  deleteWorktreeFile,
  renameWorktreeFile,
  searchFileContents,
} from "./worktree";

describe("readWorktreeFile", () => {
  test("returns text content for a regular file", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "hello.txt"), "line1\nline2\n");
    expect(await readWorktreeFile(dir, "hello.txt")).toEqual({ kind: "text", content: "line1\nline2\n" });
  });

  test("rejects paths that escape the worktree", async () => {
    const dir = makeTmpDir("wt");
    const escaping = await readWorktreeFile(dir, `${"../".repeat(20)}etc/hosts`);
    expect(escaping.kind).toBe("denied");
    const absolute = await readWorktreeFile(dir, "/etc/hosts");
    expect(absolute.kind).toBe("denied");
  });

  test("rejects symlinks that point outside the worktree", async () => {
    const dir = makeTmpDir("wt");
    const outside = join(tmpdir(), `worqload-outside-${crypto.randomUUID()}.txt`);
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(dir, "leak"));
    expect((await readWorktreeFile(dir, "leak")).kind).toBe("denied");
  });

  test("returns not-found for a missing file", async () => {
    const dir = makeTmpDir("wt");
    expect((await readWorktreeFile(dir, "nope.txt")).kind).toBe("not-found");
  });

  test("returns not-a-file for a directory", async () => {
    const dir = makeTmpDir("wt");
    mkdirSync(join(dir, "adir"));
    expect((await readWorktreeFile(dir, "adir")).kind).toBe("not-a-file");
  });

  test("flags binary files", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0x68, 0x69, 0x00, 0x01, 0xff]));
    expect((await readWorktreeFile(dir, "bin.dat")).kind).toBe("binary");
  });

  test("flags files over the size limit", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "big.txt"), "a".repeat(3 * 1024 * 1024));
    const result = await readWorktreeFile(dir, "big.txt");
    expect(result.kind).toBe("too-large");
    if (result.kind === "too-large") expect(result.size).toBe(3 * 1024 * 1024);
  });

  test("classifies image files by extension, carrying their bytes and media type", async () => {
    const dir = makeTmpDir("wt");
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]);
    writeFileSync(join(dir, "pic.png"), pngBytes);
    const result = await readWorktreeFile(dir, "pic.png");
    expect(result.kind).toBe("image");
    if (result.kind === "image") {
      expect(result.mediaType).toBe("image/png");
      expect(Array.from(result.bytes)).toEqual(Array.from(pngBytes));
    }
  });
});

describe("writeWorktreeFile", () => {
  test("overwrites an existing file's content", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "hello.txt"), "old\n");
    expect((await writeWorktreeFile(dir, "hello.txt", "new\ncontent\n")).kind).toBe("ok");
    expect(readFileSync(join(dir, "hello.txt"), "utf8")).toBe("new\ncontent\n");
  });

  test("rejects paths that escape the worktree", async () => {
    const dir = makeTmpDir("wt");
    expect((await writeWorktreeFile(dir, `${"../".repeat(20)}tmp/leak.txt`, "x")).kind).toBe("denied");
    expect((await writeWorktreeFile(dir, "/etc/hosts", "x")).kind).toBe("denied");
  });

  test("rejects symlinks that point outside the worktree", async () => {
    const dir = makeTmpDir("wt");
    const outside = join(tmpdir(), `worqload-outside-${crypto.randomUUID()}.txt`);
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(dir, "leak"));
    expect((await writeWorktreeFile(dir, "leak", "overwritten")).kind).toBe("denied");
    expect(readFileSync(outside, "utf8")).toBe("secret\n");
  });

  test("returns not-found for a missing file", async () => {
    const dir = makeTmpDir("wt");
    expect((await writeWorktreeFile(dir, "nope.txt", "x")).kind).toBe("not-found");
  });

  test("returns not-a-file for a directory", async () => {
    const dir = makeTmpDir("wt");
    mkdirSync(join(dir, "adir"));
    expect((await writeWorktreeFile(dir, "adir", "x")).kind).toBe("not-a-file");
  });
});

describe("createWorktreeFile", () => {
  test("creates a new file with the given content", async () => {
    const dir = makeTmpDir("wt");
    expect((await createWorktreeFile(dir, "fresh.txt", "hello\n")).kind).toBe("ok");
    expect(readFileSync(join(dir, "fresh.txt"), "utf8")).toBe("hello\n");
  });

  test("creates missing parent directories", async () => {
    const dir = makeTmpDir("wt");
    expect((await createWorktreeFile(dir, "a/b/c.txt", "deep\n")).kind).toBe("ok");
    expect(readFileSync(join(dir, "a", "b", "c.txt"), "utf8")).toBe("deep\n");
  });

  test("returns exists when the path is already taken", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "taken.txt"), "original\n");
    expect((await createWorktreeFile(dir, "taken.txt", "x")).kind).toBe("exists");
    expect(readFileSync(join(dir, "taken.txt"), "utf8")).toBe("original\n");
  });

  test("rejects paths that escape the worktree", async () => {
    const dir = makeTmpDir("wt");
    expect((await createWorktreeFile(dir, `${"../".repeat(20)}tmp/leak.txt`, "x")).kind).toBe("denied");
    expect((await createWorktreeFile(dir, "/tmp/leak.txt", "x")).kind).toBe("denied");
  });

  test("rejects paths whose directory segment symlinks outside the worktree", async () => {
    const dir = makeTmpDir("wt");
    const outsideDir = join(tmpdir(), `worqload-outside-${crypto.randomUUID()}`);
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, join(dir, "escape"));
    expect((await createWorktreeFile(dir, "escape/pwned.txt", "x")).kind).toBe("denied");
    expect(existsSync(join(outsideDir, "pwned.txt"))).toBe(false);
  });
});

describe("deleteWorktreeFile", () => {
  test("removes an existing file", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "gone.txt"), "bye\n");
    expect((await deleteWorktreeFile(dir, "gone.txt")).kind).toBe("ok");
    expect(existsSync(join(dir, "gone.txt"))).toBe(false);
  });

  test("returns not-found for a missing file", async () => {
    const dir = makeTmpDir("wt");
    expect((await deleteWorktreeFile(dir, "nope.txt")).kind).toBe("not-found");
  });

  test("returns not-a-file for a directory", async () => {
    const dir = makeTmpDir("wt");
    mkdirSync(join(dir, "adir"));
    expect((await deleteWorktreeFile(dir, "adir")).kind).toBe("not-a-file");
    expect(existsSync(join(dir, "adir"))).toBe(true);
  });

  test("rejects paths that escape the worktree", async () => {
    const dir = makeTmpDir("wt");
    expect((await deleteWorktreeFile(dir, `${"../".repeat(20)}etc/hosts`)).kind).toBe("denied");
    expect((await deleteWorktreeFile(dir, "/etc/hosts")).kind).toBe("denied");
  });

  test("rejects symlinks that point outside the worktree", async () => {
    const dir = makeTmpDir("wt");
    const outside = join(tmpdir(), `worqload-outside-${crypto.randomUUID()}.txt`);
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(dir, "leak"));
    expect((await deleteWorktreeFile(dir, "leak")).kind).toBe("denied");
    expect(existsSync(outside)).toBe(true);
  });
});

describe("renameWorktreeFile", () => {
  test("renames a file, preserving content", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "old.txt"), "keep me\n");
    expect((await renameWorktreeFile(dir, "old.txt", "new.txt")).kind).toBe("ok");
    expect(existsSync(join(dir, "old.txt"))).toBe(false);
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("keep me\n");
  });

  test("creates missing parent directories of the destination", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "flat.txt"), "moved\n");
    expect((await renameWorktreeFile(dir, "flat.txt", "nested/dir/deep.txt")).kind).toBe("ok");
    expect(readFileSync(join(dir, "nested", "dir", "deep.txt"), "utf8")).toBe("moved\n");
  });

  test("returns not-found when the source is missing", async () => {
    const dir = makeTmpDir("wt");
    expect((await renameWorktreeFile(dir, "ghost.txt", "new.txt")).kind).toBe("not-found");
  });

  test("returns not-a-file when the source is a directory", async () => {
    const dir = makeTmpDir("wt");
    mkdirSync(join(dir, "adir"));
    expect((await renameWorktreeFile(dir, "adir", "bdir")).kind).toBe("not-a-file");
  });

  test("returns exists when the destination is already taken", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "from.txt"), "from\n");
    writeFileSync(join(dir, "to.txt"), "to\n");
    expect((await renameWorktreeFile(dir, "from.txt", "to.txt")).kind).toBe("exists");
    expect(readFileSync(join(dir, "from.txt"), "utf8")).toBe("from\n");
    expect(readFileSync(join(dir, "to.txt"), "utf8")).toBe("to\n");
  });

  test("rejects a source or destination that escapes the worktree", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "real.txt"), "x\n");
    expect((await renameWorktreeFile(dir, `${"../".repeat(20)}etc/hosts`, "new.txt")).kind).toBe("denied");
    expect((await renameWorktreeFile(dir, "real.txt", `${"../".repeat(20)}tmp/leak.txt`)).kind).toBe("denied");
    expect((await renameWorktreeFile(dir, "real.txt", "/tmp/leak.txt")).kind).toBe("denied");
  });
});

describe("searchFileContents", () => {
  test("finds case-insensitive substring matches with path, 1-based line, and the matching line", async () => {
    const dir = makeTmpDir("wt");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "const Needle = 1;\nother\nuse needle here\n");
    writeFileSync(join(dir, "src", "b.ts"), "nothing\n");
    writeFileSync(join(dir, "notes.md"), "a NEEDLE in markdown\n");

    const { matches, truncated } = await searchFileContents(
      dir,
      ["src/a.ts", "src/b.ts", "notes.md"],
      "needle",
    );
    expect(truncated).toBe(false);
    expect(matches).toEqual([
      { path: "src/a.ts", line: 1, text: "const Needle = 1;" },
      { path: "src/a.ts", line: 3, text: "use needle here" },
      { path: "notes.md", line: 1, text: "a NEEDLE in markdown" },
    ]);
  });

  test("skips binary files", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "bin.dat"), Buffer.concat([Buffer.from("needle"), Buffer.from([0x00, 0x01])]));
    writeFileSync(join(dir, "text.txt"), "needle\n");
    const { matches } = await searchFileContents(dir, ["bin.dat", "text.txt"], "needle");
    expect(matches).toEqual([{ path: "text.txt", line: 1, text: "needle" }]);
  });

  test("returns no matches for an empty query", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "f.txt"), "anything\n");
    expect(await searchFileContents(dir, ["f.txt"], "")).toEqual({ matches: [], truncated: false });
  });

  test("caps the result count and reports truncation", async () => {
    const dir = makeTmpDir("wt");
    writeFileSync(join(dir, "many.txt"), Array.from({ length: 250 }, () => "needle").join("\n") + "\n");
    const { matches, truncated } = await searchFileContents(dir, ["many.txt"], "needle");
    expect(matches.length).toBe(200);
    expect(truncated).toBe(true);
    expect(matches[0]).toEqual({ path: "many.txt", line: 1, text: "needle" });
  });
});

