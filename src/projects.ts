import { homedir } from "os";
import { join, resolve, basename } from "path";
import { EntityStore } from "./utils/entity-store";

export interface Project {
  id: string;
  name: string;
  path: string;
  registeredAt: string;
}

const DEFAULT_PROJECTS_PATH = join(homedir(), ".worqload", "projects.json");

const store = new EntityStore<Project>(DEFAULT_PROJECTS_PATH, "Project");

export async function loadProjects(projectsPath: string = DEFAULT_PROJECTS_PATH): Promise<Project[]> {
  return store.load(projectsPath);
}

export async function registerProject(projectPath: string, name?: string, projectsPath: string = DEFAULT_PROJECTS_PATH): Promise<Project> {
  const absPath = resolve(projectPath);
  const projectName = name || basename(absPath);

  const projects = await store.load(projectsPath);
  if (projects.some(p => p.path === absPath)) {
    throw new Error(`Project already registered: ${absPath}`);
  }
  if (projects.some(p => p.name === projectName)) {
    throw new Error(`Project name already taken: ${projectName}`);
  }

  return store.create({
    name: projectName,
    path: absPath,
    registeredAt: new Date().toISOString(),
  }, projectsPath);
}

export async function removeProject(name: string, projectsPath: string = DEFAULT_PROJECTS_PATH): Promise<void> {
  const projects = await store.load(projectsPath);
  const target = projects.find(p => p.name === name);
  if (!target) {
    throw new Error(`Project not found: ${name}`);
  }
  await store.remove(target.id, projectsPath);
}
