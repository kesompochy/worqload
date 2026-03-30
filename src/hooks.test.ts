import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { runOnDoneHooks } from "./hooks";

function tmpPath(name: string): string {
  return join(tmpdir(), `worqload-hooks-test-${name}-${crypto.randomUUID()}.json`);
}

let configPath: string;
let tasksPath: string;

beforeEach(() => {
  configPath = tmpPath("config");
  tasksPath = tmpPath("tasks");
});

test("runOnDoneHooks does nothing when no onDone hooks configured", async () => {
  await Bun.write(configPath, JSON.stringify({}));
  await runOnDoneHooks("task-123", "Test task", configPath);
  // No error thrown
});

test("runOnDoneHooks runs configured commands", async () => {
  const markerPath = tmpPath("marker");
  await Bun.write(configPath, JSON.stringify({
    onDone: [`touch ${markerPath}`],
  }));

  await runOnDoneHooks("task-123", "Test task", configPath);

  const file = Bun.file(markerPath);
  expect(await file.exists()).toBe(true);
});

test("runOnDoneHooks passes task env vars to hooks", async () => {
  const outputPath = tmpPath("env-output");
  await Bun.write(configPath, JSON.stringify({
    onDone: [`echo "ID=$WORQLOAD_DONE_TASK_ID TITLE=$WORQLOAD_DONE_TASK_TITLE" > ${outputPath}`],
  }));

  await runOnDoneHooks("abc-123", "My task", configPath);

  const content = await Bun.file(outputPath).text();
  expect(content.trim()).toBe("ID=abc-123 TITLE=My task");
});

test("runOnDoneHooks runs multiple hooks in order", async () => {
  const outputPath = tmpPath("multi-output");
  await Bun.write(configPath, JSON.stringify({
    onDone: [
      `echo "first" > ${outputPath}`,
      `echo "second" >> ${outputPath}`,
    ],
  }));

  await runOnDoneHooks("task-1", "Task", configPath);

  const content = await Bun.file(outputPath).text();
  expect(content.trim()).toBe("first\nsecond");
});

test("runOnDoneHooks continues on hook failure", async () => {
  const outputPath = tmpPath("fail-output");
  await Bun.write(configPath, JSON.stringify({
    onDone: [
      "exit 1",
      `echo "ran" > ${outputPath}`,
    ],
  }));

  await runOnDoneHooks("task-1", "Task", configPath);

  const content = await Bun.file(outputPath).text();
  expect(content.trim()).toBe("ran");
});
