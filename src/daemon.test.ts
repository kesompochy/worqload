import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { buildDaemonCommand, launchMissionDaemon } from "./daemon";

function tmpDir(label: string): string {
  return join(tmpdir(), `worqload-daemon-${label}-${crypto.randomUUID()}`);
}

describe("buildDaemonCommand", () => {
  test("includes --foreground flag", () => {
    const cmd = buildDaemonCommand("abc123");
    expect(cmd).toContain("--foreground");
  });

  test("includes mission run subcommand and mission id", () => {
    const cmd = buildDaemonCommand("abc123");
    const missionIdx = cmd.indexOf("mission");
    expect(missionIdx).toBeGreaterThan(0);
    expect(cmd[missionIdx + 1]).toBe("run");
    expect(cmd[missionIdx + 2]).toBe("abc123");
  });

  test("starts with process.execPath", () => {
    const cmd = buildDaemonCommand("abc123");
    expect(cmd[0]).toBe(process.execPath);
  });
});

describe("launchMissionDaemon", () => {
  test("spawns process and returns pid and logPath", async () => {
    const logDir = tmpDir("spawn");
    const result = await launchMissionDaemon("test-mission", {
      logDir,
      command: ["sh", "-c", "echo daemon-started"],
    });

    expect(result.pid).toBeGreaterThan(0);
    expect(result.logPath).toContain("mission-test-mission.log");

    // Wait for process to finish writing
    await Bun.sleep(200);
    const logContent = await Bun.file(result.logPath).text();
    expect(logContent).toContain("daemon-started");
  });

  test("creates log directory if it doesn't exist", async () => {
    const logDir = tmpDir("mkdir");
    const result = await launchMissionDaemon("test", {
      logDir,
      command: ["echo", "ok"],
    });

    await Bun.sleep(200);
    const exists = await Bun.file(result.logPath).exists();
    expect(exists).toBeTrue();
  });

  test("returns immediately without waiting for process exit", async () => {
    const logDir = tmpDir("unref");
    const start = Date.now();
    const result = await launchMissionDaemon("test-unref", {
      logDir,
      command: ["sh", "-c", "sleep 2 && echo done"],
    });
    const elapsed = Date.now() - start;

    expect(result.pid).toBeGreaterThan(0);
    // Should return well before the 2s sleep completes
    expect(elapsed).toBeLessThan(500);

    // Clean up: kill the background process
    try { process.kill(result.pid, 9); } catch {}
  });
});
