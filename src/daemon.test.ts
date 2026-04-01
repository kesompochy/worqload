import { test, expect, describe, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { buildDaemonCommand, launchMissionDaemon } from "./daemon";
import { createTask } from "./task";
import { TaskQueue } from "./queue";
import { createMission, addMissionPrinciple, loadMissions } from "./mission";
import { load } from "./store";

const spawnedPids: number[] = [];

function tmpDir(label: string): string {
  return join(tmpdir(), `worqload-daemon-${label}-${crypto.randomUUID()}`);
}

function tmpPath(label: string): string {
  return join(tmpdir(), `worqload-daemon-${label}-${crypto.randomUUID()}.json`);
}

async function pollForTaskDone(storePath: string, taskId: string, timeoutMs = 15000, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tasks = await load(storePath);
      const task = tasks.find(t => t.id === taskId);
      if (task && (task.status === "done" || task.status === "failed")) {
        return task.status === "done";
      }
    } catch {}
    await Bun.sleep(intervalMs);
  }
  return false;
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

  test("starts with nohup to survive parent death", () => {
    const cmd = buildDaemonCommand("abc123");
    expect(cmd[0]).toBe("nohup");
  });
});

afterEach(() => {
  for (const pid of spawnedPids) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  spawnedPids.length = 0;
});

describe("launchMissionDaemon", () => {
  test("spawns process and returns pid and logPath", async () => {
    const logDir = tmpDir("spawn");
    const result = await launchMissionDaemon("test-mission", {
      logDir,
      command: ["sh", "-c", "echo daemon-started"],
    });
    spawnedPids.push(result.pid);

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
    spawnedPids.push(result.pid);

    await Bun.sleep(200);
    const exists = await Bun.file(result.logPath).exists();
    expect(exists).toBeTrue();
  });

  test("returns immediately without waiting for process exit", async () => {
    const logDir = tmpDir("unref");
    const start = Date.now();
    const result = await launchMissionDaemon("test-unref", {
      logDir,
      command: ["nohup", "sh", "-c", "sleep 2 && echo done"],
    });
    spawnedPids.push(result.pid);
    const elapsed = Date.now() - start;

    expect(result.pid).toBeGreaterThan(0);
    // Should return well before the 2s sleep completes
    expect(elapsed).toBeLessThan(500);
  });

  test("child process survives SIGHUP", async () => {
    const logDir = tmpDir("sighup");
    const result = await launchMissionDaemon("test-sighup", {
      logDir,
      command: ["nohup", "sh", "-c", "sleep 1 && echo survived"],
    });
    spawnedPids.push(result.pid);

    // Allow nohup to set up signal handling before sending SIGHUP
    await Bun.sleep(200);
    try { process.kill(result.pid, "SIGHUP"); } catch {}

    // Wait for process to finish
    await Bun.sleep(1500);
    const logContent = await Bun.file(result.logPath).text();
    expect(logContent).toContain("survived");
  });
});

// Generates a Bun script that imports runMission and executes it with the given options.
// This script runs as a separate process to simulate daemon behavior.
function buildRunnerScript(missionId: string, opts: {
  storePath: string;
  missionsPath: string;
  runnerStatePath: string;
}): string {
  return `
import { runMission } from "${join(process.cwd(), "src/mission-runner.ts")}";
await runMission("${missionId}", {
  storePath: "${opts.storePath}",
  missionsPath: "${opts.missionsPath}",
  runnerStatePath: "${opts.runnerStatePath}",
  pollIntervalMs: 50,
  idleTimeoutMs: 5000,
  actCommand: ["echo", "task-completed"],
});
`;
}

describe("daemon integration: launchMissionDaemon runs mission to completion", () => {
  test("daemon process completes a task via runMission", async () => {
    const storePath = tmpPath("integ-store");
    const missionsPath = tmpPath("integ-missions");
    const runnerStatePath = tmpPath("integ-runners");
    const logDir = tmpDir("integ-logs");
    const scriptDir = tmpDir("integ-script");
    await mkdir(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "runner.ts");

    const mission = await createMission("daemon-integ", {}, missionsPath);
    await addMissionPrinciple(mission.id, "Complete tasks efficiently", missionsPath);

    const task = createTask("daemon integration test task");
    const queue = new TaskQueue(storePath);
    queue.enqueue({ ...task, missionId: mission.id });
    await queue.save();

    const script = buildRunnerScript(mission.id, { storePath, missionsPath, runnerStatePath });
    await writeFile(scriptPath, script);

    const result = await launchMissionDaemon(mission.id, {
      logDir,
      command: ["nohup", process.execPath, "run", scriptPath],
    });
    spawnedPids.push(result.pid);

    expect(result.pid).toBeGreaterThan(0);

    const done = await pollForTaskDone(storePath, task.id);
    expect(done).toBeTrue();

    const tasks = await load(storePath);
    const completed = tasks.find(t => t.id === task.id);
    expect(completed?.status).toBe("done");
    expect(completed?.logs.some(l => l.phase === "act")).toBeTrue();
  }, 20000);

  test("daemon process survives SIGHUP and still completes task", async () => {
    const storePath = tmpPath("sighup-store");
    const missionsPath = tmpPath("sighup-missions");
    const runnerStatePath = tmpPath("sighup-runners");
    const logDir = tmpDir("sighup-logs");
    const scriptDir = tmpDir("sighup-script");
    await mkdir(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "runner.ts");

    const mission = await createMission("sighup-integ", {}, missionsPath);
    await addMissionPrinciple(mission.id, "Survive interruption", missionsPath);

    const task = createTask("sighup survival test task");
    const queue = new TaskQueue(storePath);
    queue.enqueue({ ...task, missionId: mission.id });
    await queue.save();

    // Add a delay before processing so we can send SIGHUP while the process is alive
    const scriptContent = `
import { runMission } from "${join(process.cwd(), "src/mission-runner.ts")}";
await Bun.sleep(500);
await runMission("${mission.id}", {
  storePath: "${storePath}",
  missionsPath: "${missionsPath}",
  runnerStatePath: "${runnerStatePath}",
  pollIntervalMs: 50,
  idleTimeoutMs: 5000,
  actCommand: ["echo", "survived-sighup"],
});
`;
    await writeFile(scriptPath, scriptContent);

    const result = await launchMissionDaemon(mission.id, {
      logDir,
      command: ["nohup", process.execPath, "run", scriptPath],
    });
    spawnedPids.push(result.pid);

    // Send SIGHUP shortly after launch, before task processing begins
    await Bun.sleep(200);
    try { process.kill(result.pid, "SIGHUP"); } catch {}

    const done = await pollForTaskDone(storePath, task.id);
    expect(done).toBeTrue();

    const tasks = await load(storePath);
    const completed = tasks.find(t => t.id === task.id);
    expect(completed?.status).toBe("done");
  }, 20000);
});
