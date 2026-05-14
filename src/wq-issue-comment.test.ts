import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "bin", "wq-issue-comment");

// Drops a fake `worqload` binary into `dir` that records the argv it received
// (NUL-separated so a body with embedded newlines doesn't smear into the next
// arg) and whatever arrived on stdin, then prints a synthetic asking-file
// name on stdout.
function installFakeWorqload(dir: string): void {
  const fake =
    "#!/usr/bin/env bash\n" +
    `printf '%s\\0' "$@" > "${dir}/argv.bin"\n` +
    `cat > "${dir}/stdin.txt"\n` +
    "echo 999-captured.md\n";
  const path = join(dir, "worqload");
  writeFileSync(path, fake);
  chmodSync(path, 0o755);
}

function readCapturedArgv(dir: string): string[] {
  const raw = readFileSync(join(dir, "argv.bin"), "utf8");
  // printf '%s\0' emits a trailing NUL after the last arg, so drop the empty
  // tail entry that produces.
  const parts = raw.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

async function runScript(
  args: string[],
  stdin: string,
  binDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([SCRIPT, ...args], {
    stdin: new Response(stdin).body ?? undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("wq-issue-comment", () => {
  test("queues a command approval that wraps gh issue comment with the body single-quoted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wq-issue-comment-"));
    installFakeWorqload(dir);

    const { exitCode, stdout } = await runScript(["123"], "hello\nworld\n", dir);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("999-captured.md");

    const argv = readCapturedArgv(dir);
    expect(argv.slice(0, 3)).toEqual(["escalate", "command", "--command"]);
    expect(argv[3]).toBe("gh issue comment '123' --body 'hello\nworld'");

    const reasonStdin = readFileSync(join(dir, "stdin.txt"), "utf8");
    expect(reasonStdin).toContain("123");
    expect(reasonStdin).toContain("hello\nworld");
  });

  test("escapes single quotes in the body so the assembled sh command stays well-formed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wq-issue-comment-"));
    installFakeWorqload(dir);

    const { exitCode } = await runScript(["42"], "it's a 'quote'\n", dir);

    expect(exitCode).toBe(0);
    const argv = readCapturedArgv(dir);
    // Each `'` becomes `'\''` (end-quote, escaped quote, re-open-quote), so
    // the body lives inside a single pair of single quotes that sh sees as
    // the literal string `it's a 'quote'`. The trailing `'` in the body
    // produces `'\''` right before the wrapping close quote, leaving three
    // `'` characters in a row at the end.
    expect(argv[3]).toBe("gh issue comment '42' --body 'it'\\''s a '\\''quote'\\'''");
  });

  test("rejects a whitespace-only body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wq-issue-comment-"));
    installFakeWorqload(dir);

    const { exitCode, stderr } = await runScript(["123"], "   \n\t\n", dir);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("body");
  });

  test("prints usage and exits non-zero when the issue argument is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wq-issue-comment-"));
    installFakeWorqload(dir);

    const { exitCode, stderr } = await runScript([], "body\n", dir);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("Usage");
  });
});
