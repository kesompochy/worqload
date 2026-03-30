import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadSources,
  saveSources,
  addSource,
  removeSource,
  runSource,
  runAllSources,
} from "./sources";
import type { Source } from "./sources";

function tmpSourcesPath(): string {
  return join(tmpdir(), `worqload-sources-test-${crypto.randomUUID()}.json`);
}

const shellSource: Source = { name: "echo-test", type: "shell", command: "echo hello" };

test("loadSources returns empty array when file does not exist", async () => {
  const path = tmpSourcesPath();
  expect(await loadSources(path)).toEqual([]);
});

test("saveSources then loadSources round-trips", async () => {
  const path = tmpSourcesPath();
  const sources: Source[] = [shellSource];

  await saveSources(sources, path);
  const loaded = await loadSources(path);

  expect(loaded).toHaveLength(1);
  expect(loaded[0].name).toBe("echo-test");
  expect(loaded[0].command).toBe("echo hello");
});

test("addSource appends a new source", async () => {
  const path = tmpSourcesPath();
  await addSource(shellSource, path);

  const loaded = await loadSources(path);
  expect(loaded).toHaveLength(1);
  expect(loaded[0].name).toBe("echo-test");
});

test("addSource throws on duplicate name", async () => {
  const path = tmpSourcesPath();
  await addSource(shellSource, path);
  expect(addSource(shellSource, path)).rejects.toThrow("Source already exists: echo-test");
});

test("removeSource removes an existing source", async () => {
  const path = tmpSourcesPath();
  await addSource(shellSource, path);
  await removeSource("echo-test", path);

  const loaded = await loadSources(path);
  expect(loaded).toHaveLength(0);
});

test("removeSource throws when source not found", async () => {
  const path = tmpSourcesPath();
  expect(removeSource("nonexistent", path)).rejects.toThrow("Source not found: nonexistent");
});

test("runSource executes shell command and captures output", async () => {
  const result = await runSource({ name: "greet", type: "shell", command: "echo hi" });
  expect(result.name).toBe("greet");
  expect(result.output).toBe("hi");
  expect(result.exitCode).toBe(0);
});

test("runSource captures non-zero exit code", async () => {
  const result = await runSource({ name: "fail", type: "shell", command: "exit 42" });
  expect(result.exitCode).toBe(42);
});

test("runSource captures stderr", async () => {
  const result = await runSource({ name: "err", type: "shell", command: "echo oops >&2" });
  expect(result.output).toBe("oops");
  expect(result.exitCode).toBe(0);
});

test("runAllSources runs all registered sources", async () => {
  const path = tmpSourcesPath();
  await addSource({ name: "a", type: "shell", command: "echo AAA" }, path);
  await addSource({ name: "b", type: "shell", command: "echo BBB" }, path);

  const results = await runAllSources(path);
  expect(results).toHaveLength(2);
  expect(results[0].name).toBe("a");
  expect(results[0].output).toBe("AAA");
  expect(results[1].name).toBe("b");
  expect(results[1].output).toBe("BBB");
});

test("runAllSources returns empty array when no sources registered", async () => {
  const path = tmpSourcesPath();
  expect(await runAllSources(path)).toEqual([]);
});
