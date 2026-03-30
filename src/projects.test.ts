import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { loadProjects, registerProject, removeProject } from "./projects";

function tmpPath(): string {
  return join(tmpdir(), `worqload-projects-test-${crypto.randomUUID()}`, "projects.json");
}

test("loadProjects returns empty array when file does not exist", async () => {
  expect(await loadProjects(tmpPath())).toEqual([]);
});

test("registerProject creates and persists a project", async () => {
  const path = tmpPath();
  const project = await registerProject("/tmp/my-project", "my-project", path);

  expect(project.name).toBe("my-project");
  expect(project.path).toBe("/tmp/my-project");

  const loaded = await loadProjects(path);
  expect(loaded).toHaveLength(1);
  expect(loaded[0].name).toBe("my-project");
});

test("registerProject derives name from path basename", async () => {
  const path = tmpPath();
  const project = await registerProject("/tmp/derived-name", undefined, path);
  expect(project.name).toBe("derived-name");
});

test("registerProject throws on duplicate path", async () => {
  const path = tmpPath();
  await registerProject("/tmp/dup-path", "first", path);
  expect(registerProject("/tmp/dup-path", "second", path)).rejects.toThrow("Project already registered");
});

test("registerProject throws on duplicate name", async () => {
  const path = tmpPath();
  await registerProject("/tmp/path-a", "same-name", path);
  expect(registerProject("/tmp/path-b", "same-name", path)).rejects.toThrow("Project name already taken");
});

test("removeProject removes a registered project", async () => {
  const path = tmpPath();
  await registerProject("/tmp/to-remove", "removable", path);
  await removeProject("removable", path);

  const loaded = await loadProjects(path);
  expect(loaded).toEqual([]);
});

test("removeProject throws for unknown name", async () => {
  const path = tmpPath();
  expect(removeProject("nonexistent", path)).rejects.toThrow("Project not found");
});
