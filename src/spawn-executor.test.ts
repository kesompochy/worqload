import { test, expect, describe } from "bun:test";
import {
  killProcessTree,
  spawnWithTimeout,
  SpawnTimeoutError,
  buildTaskEnv,
  truncateOutput,
  DEFAULT_SPAWN_TIMEOUT_MS,
  phaseLog,
  buildSpawnOutcomeUpdate,
  buildSpawnTimeoutUpdate,
} from "./spawn-executor";

describe("DEFAULT_SPAWN_TIMEOUT_MS", () => {
  test("is 30 minutes", () => {
    expect(DEFAULT_SPAWN_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});

describe("truncateOutput", () => {
  test("returns short output unchanged", () => {
    expect(truncateOutput("hello")).toBe("hello");
  });

  test("truncates to last 2000 chars by default", () => {
    const long = "x".repeat(3000);
    const result = truncateOutput(long);
    expect(result.length).toBe(2000);
    expect(result).toBe("x".repeat(2000));
  });

  test("uses custom maxLength", () => {
    const long = "x".repeat(200);
    const result = truncateOutput(long, 100);
    expect(result.length).toBe(100);
  });

  test("keeps tail of output when truncating", () => {
    const output = "HEAD" + "x".repeat(2000) + "TAIL";
    const result = truncateOutput(output);
    expect(result).toEndWith("TAIL");
    expect(result).not.toContain("HEAD");
  });
});

describe("buildTaskEnv", () => {
  test("sets basic task environment variables", () => {
    const env = buildTaskEnv({
      taskId: "task-1",
      taskTitle: "Test task",
      taskContext: { key: "value" },
    });
    expect(env.WORQLOAD_TASK_ID).toBe("task-1");
    expect(env.WORQLOAD_TASK_TITLE).toBe("Test task");
    expect(env.WORQLOAD_TASK_CONTEXT).toBe('{"key":"value"}');
    expect(env.WORQLOAD_CLI).toBeDefined();
  });

  test("sets WORQLOAD_CLI to an absolute path when worqload is available", () => {
    const env = buildTaskEnv({
      taskId: "t",
      taskTitle: "t",
      taskContext: {},
    });
    // Should resolve to an absolute path or fall back to process.argv[0]
    expect(env.WORQLOAD_CLI).toBeTruthy();
  });

  test("includes mission principles when provided", () => {
    const env = buildTaskEnv({
      taskId: "t",
      taskTitle: "t",
      taskContext: {},
      missionPrinciples: ["TDD first", "Small commits"],
    });
    expect(env.WORQLOAD_MISSION_PRINCIPLES).toBe("TDD first\nSmall commits");
  });

  test("omits mission principles when empty array", () => {
    const env = buildTaskEnv({
      taskId: "t",
      taskTitle: "t",
      taskContext: {},
      missionPrinciples: [],
    });
    expect(env.WORQLOAD_MISSION_PRINCIPLES).toBeUndefined();
  });

  test("omits mission principles when not provided", () => {
    const env = buildTaskEnv({
      taskId: "t",
      taskTitle: "t",
      taskContext: {},
    });
    expect(env.WORQLOAD_MISSION_PRINCIPLES).toBeUndefined();
  });
});

describe("killProcessTree", () => {
  test("kills a running process", async () => {
    const proc = Bun.spawn(["sleep", "300"], { stdout: "pipe", stderr: "pipe" });
    const pid = proc.pid;

    // Verify process is alive
    expect(() => process.kill(pid, 0)).not.toThrow();

    killProcessTree(pid);
    await Bun.sleep(100);

    // Verify process is dead
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("does not throw for non-existent pid", () => {
    expect(() => killProcessTree(999999)).not.toThrow();
  });
});

describe("SpawnTimeoutError", () => {
  test("has correct name and message", () => {
    const err = new SpawnTimeoutError(5000);
    expect(err.name).toBe("SpawnTimeoutError");
    expect(err.message).toBe("Spawn timed out after 5000ms");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("phaseLog", () => {
  test("creates log entry with phase, content, and ISO timestamp", () => {
    const log = phaseLog("act", "test content");
    expect(log.phase).toBe("act");
    expect(log.content).toBe("test content");
    expect(new Date(log.timestamp).toISOString()).toBe(log.timestamp);
  });
});

describe("buildSpawnOutcomeUpdate", () => {
  const baseCurrent = {
    logs: [],
    status: "acting" as const,
    context: {},
  };

  test("exit code 0 → done", () => {
    const result = buildSpawnOutcomeUpdate(0, "output", baseCurrent);
    expect(result.status).toBe("done");
    expect(result.owner).toBeUndefined();
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].phase).toBe("act");
    expect(result.logs[0].content).toBe("output");
  });

  test("exit code ESCALATION_EXIT_CODE → waiting_human", () => {
    const result = buildSpawnOutcomeUpdate(3, "question", baseCurrent);
    expect(result.status).toBe("waiting_human");
    expect(result.owner).toBeUndefined();
    expect(result.logs).toHaveLength(2);
    expect(result.logs[0].phase).toBe("act");
    expect(result.logs[1].phase).toBe("orient");
    expect(result.logs[1].content).toContain("[HUMAN REQUIRED]");
    expect(result.logs[1].content).toContain("question");
  });

  test("escalation with empty output uses default message", () => {
    const result = buildSpawnOutcomeUpdate(3, "", baseCurrent);
    expect(result.logs[1].content).toContain("Spawned agent requested human escalation");
  });

  test("non-zero exit without retry → failed", () => {
    const result = buildSpawnOutcomeUpdate(1, "error", baseCurrent);
    expect(result.status).toBe("failed");
    expect(result.logs).toHaveLength(2);
    expect(result.logs[1].content).toContain("[FAILED] exit code 1");
  });

  test("non-zero exit with retryPolicy, can retry → observing with retry context", () => {
    const retryPolicy = {
      canRetry: () => true,
      computeRetry: () => ({ retryCount: 1, retryAfter: "2026-01-01T00:00:00.000Z" }),
      maxRetries: 2,
    };
    const result = buildSpawnOutcomeUpdate(1, "error", baseCurrent, { retryPolicy });
    expect(result.status).toBe("observing");
    expect(result.context?.retryCount).toBe(1);
    expect(result.context?.retryAfter).toBe("2026-01-01T00:00:00.000Z");
    expect(result.logs[1].content).toContain("[RETRY] 1/2");
  });

  test("non-zero exit with retryPolicy, cannot retry → failed", () => {
    const retryPolicy = {
      canRetry: () => false,
      computeRetry: () => ({ retryCount: 3, retryAfter: "" }),
      maxRetries: 2,
    };
    const result = buildSpawnOutcomeUpdate(1, "error", baseCurrent, { retryPolicy });
    expect(result.status).toBe("failed");
    expect(result.logs[1].content).toContain("[FAILED] exit code 1");
  });

  test("non-zero exit with skipRetry → failed even if retryPolicy allows", () => {
    const retryPolicy = {
      canRetry: () => true,
      computeRetry: () => ({ retryCount: 1, retryAfter: "" }),
      maxRetries: 2,
    };
    const result = buildSpawnOutcomeUpdate(1, "error", baseCurrent, { retryPolicy, skipRetry: true });
    expect(result.status).toBe("failed");
  });

  test("already terminal status → logs only, no status change", () => {
    const doneCurrent = { ...baseCurrent, status: "done" as const };
    const result = buildSpawnOutcomeUpdate(0, "output", doneCurrent);
    expect(result.status).toBeUndefined();
    expect(result.owner).toBeUndefined();
    expect(result.logs).toHaveLength(1);
  });

  test("already failed status → logs only, no status change", () => {
    const failedCurrent = { ...baseCurrent, status: "failed" as const };
    const result = buildSpawnOutcomeUpdate(1, "error", failedCurrent);
    expect(result.status).toBeUndefined();
    expect(result.logs).toHaveLength(1);
  });

  test("preserves existing logs", () => {
    const current = {
      ...baseCurrent,
      logs: [{ phase: "observe" as const, content: "existing", timestamp: "2026-01-01T00:00:00.000Z" }],
    };
    const result = buildSpawnOutcomeUpdate(0, "new", current);
    expect(result.logs).toHaveLength(2);
    expect(result.logs[0].content).toBe("existing");
    expect(result.logs[1].content).toBe("new");
  });
});

describe("buildSpawnTimeoutUpdate", () => {
  const baseCurrent = {
    logs: [],
    status: "acting" as const,
    context: {},
  };

  test("timeout without retry → failed", () => {
    const result = buildSpawnTimeoutUpdate(30000, baseCurrent);
    expect(result.status).toBe("failed");
    expect(result.owner).toBeUndefined();
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].content).toContain("[TIMEOUT]");
    expect(result.logs[0].content).toContain("30000ms");
  });

  test("timeout with retry, can retry → observing with retry context", () => {
    const retryPolicy = {
      canRetry: () => true,
      computeRetry: () => ({ retryCount: 1, retryAfter: "2026-01-01T00:00:00.000Z" }),
      maxRetries: 2,
    };
    const result = buildSpawnTimeoutUpdate(30000, baseCurrent, { retryPolicy });
    expect(result.status).toBe("observing");
    expect(result.context?.retryCount).toBe(1);
    expect(result.logs[0].content).toContain("[TIMEOUT]");
  });

  test("timeout with retry, cannot retry → failed with exhaustion log", () => {
    const retryPolicy = {
      canRetry: () => false,
      computeRetry: () => ({ retryCount: 3, retryAfter: "" }),
      maxRetries: 2,
    };
    const result = buildSpawnTimeoutUpdate(30000, baseCurrent, { retryPolicy });
    expect(result.status).toBe("failed");
    expect(result.logs).toHaveLength(2);
    expect(result.logs[0].content).toContain("[TIMEOUT]");
    expect(result.logs[1].content).toContain("[FAILED] timeout after 2 retries");
  });

  test("timeout without retryPolicy → failed, no exhaustion log", () => {
    const result = buildSpawnTimeoutUpdate(30000, baseCurrent);
    expect(result.status).toBe("failed");
    expect(result.logs).toHaveLength(1);
  });

  test("timeout with skipRetry → failed", () => {
    const retryPolicy = {
      canRetry: () => true,
      computeRetry: () => ({ retryCount: 1, retryAfter: "" }),
      maxRetries: 2,
    };
    const result = buildSpawnTimeoutUpdate(30000, baseCurrent, { retryPolicy, skipRetry: true });
    expect(result.status).toBe("failed");
  });
});

describe("spawnWithTimeout", () => {
  test("returns stdout, stderr, and exitCode on success", async () => {
    const result = await spawnWithTimeout(
      ["sh", "-c", "echo hello; echo err >&2"],
      { ...process.env },
      5000,
    );
    expect(result.stdout).toContain("hello");
    expect(result.stderr).toContain("err");
    expect(result.exitCode).toBe(0);
  });

  test("returns non-zero exit code", async () => {
    const result = await spawnWithTimeout(
      ["sh", "-c", "exit 42"],
      { ...process.env },
      5000,
    );
    expect(result.exitCode).toBe(42);
  });

  test("throws SpawnTimeoutError on timeout", async () => {
    try {
      await spawnWithTimeout(
        ["sleep", "30"],
        { ...process.env },
        200,
      );
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(SpawnTimeoutError);
    }
  });

  test("passes environment variables to process", async () => {
    const result = await spawnWithTimeout(
      ["sh", "-c", "echo $TEST_VAR"],
      { ...process.env, TEST_VAR: "hello_from_env" },
      5000,
    );
    expect(result.stdout).toContain("hello_from_env");
  });

  test("uses specified cwd", async () => {
    const result = await spawnWithTimeout(
      ["pwd"],
      { ...process.env },
      5000,
      "/tmp",
    );
    // /tmp may resolve to /private/tmp on macOS
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
  });
});
