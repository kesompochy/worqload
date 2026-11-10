import { expect, test } from "bun:test";
import { join } from "node:path";
import { runAgentCliAgainstStub } from "../test-helpers";
import { renderSubmittedReminder } from "./cli-helpers";

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

test("escalate cancel requires a filename", async () => {
  const proc = Bun.spawn(["bun", CLI, "escalate", "cancel"], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      WORQLOAD_ENDPOINT: "http://localhost:0",
      WORQLOAD_SESSION_ID: "test-session",
    },
  });
  const exitCode = await proc.exited;
  expect(exitCode).toBe(2);
});

test("escalate submit prints the submitted reminder for an escalation", async () => {
  const { exitCode, stdout } = await runAgentCliAgainstStub(
    ["escalate", "submit", "--slug", "test"],
    "an escalation body",
    { filename: "001-test.md", seq: 1 },
  );
  expect(exitCode).toBe(0);
  expect(stdout).toContain(renderSubmittedReminder("escalation"));
  expect(stdout).not.toContain("{{");
});

test("escalate command prints the submitted reminder for a command approval request", async () => {
  const { exitCode, stdout } = await runAgentCliAgainstStub(
    ["escalate", "command", "--command", "echo hi"],
    "a reason",
    { filename: "001-test.md", seq: 1 },
  );
  expect(exitCode).toBe(0);
  expect(stdout).toContain(renderSubmittedReminder("command approval request"));
  expect(stdout).not.toContain("{{");
});
