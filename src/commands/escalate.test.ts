import { expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cli.ts");

test("escalate command rejects empty reason", async () => {
  const proc = Bun.spawn(["bun", CLI, "escalate", "command", "--command", "echo hi"], {
    stdin: new Blob([""]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      WORQLOAD_ENDPOINT: "http://localhost:0",
      WORQLOAD_SESSION_ID: "test-session",
    },
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(exitCode).toBe(2);
  expect(stderr).toContain("reason must be provided");
});
