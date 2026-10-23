import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cli.ts");

function spawnReport(stdin: string, extraArgs: string[] = []) {
  return Bun.spawn(["bun", CLI, "report", "submit", "--slug", "test", ...extraArgs], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      WORQLOAD_ENDPOINT: "http://localhost:0",
      WORQLOAD_SESSION_ID: "test-session",
    },
  });
}

describe("worqload report submit body validation", () => {
  test("rejects separator placeholder", async () => {
    const proc = spawnReport("--- plan report ---");
    expect(await proc.exited).toBe(2);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("write the actual content");
  });

  test("rejects kebab-case slug", async () => {
    const proc = spawnReport("investigate-disk-usage");
    expect(await proc.exited).toBe(2);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("slug");
  });

  test("--raw bypasses validation", async () => {
    const proc = spawnReport("--- plan report ---", ["--raw"]);
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).not.toContain("write the actual content");
  });
});

describe("worqload report cancel argument validation", () => {
  function spawnCancel(args: string[]) {
    return Bun.spawn(["bun", CLI, "report", "cancel", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        WORQLOAD_ENDPOINT: "http://localhost:0",
        WORQLOAD_SESSION_ID: "test-session",
      },
    });
  }

  test("requires a filename", async () => {
    expect(await spawnCancel(["--reason", "r"]).exited).toBe(2);
  });

  test("requires a reason", async () => {
    expect(await spawnCancel(["001-x.md"]).exited).toBe(2);
  });
});
