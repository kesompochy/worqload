import { homedir } from "os";
import { join } from "path";
import { mkdir } from "node:fs/promises";

export interface Project {
  name: string;
  path: string;
  registeredAt: string;
}

const GLOBAL_DIR = join(homedir(), ".worqload");
const PROJECTS_PATH = join(GLOBAL_DIR, "projects.json");

async function ensureGlobalDir(): Promise<void> {
  try {
    await mkdir(GLOBAL_DIR, { recursive: true });
  } catch {}
}

export async function loadProjects(): Promise<Project[]> {
  await ensureGlobalDir();
  const file = Bun.file(PROJECTS_PATH);
  if (!(await file.exists())) return [];
  return await file.json();
}

async function saveProjects(projects: Project[]): Promise<void> {
  await ensureGlobalDir();
  await Bun.write(PROJECTS_PATH, JSON.stringify(projects, null, 2));
}

export async function registerProject(projectPath: string, name?: string): Promise<Project> {
  const { resolve, basename } = await import("path");
  const absPath = resolve(projectPath);
  const projectName = name || basename(absPath);

  const projects = await loadProjects();
  if (projects.some(p => p.path === absPath)) {
    throw new Error(`Project already registered: ${absPath}`);
  }
  if (projects.some(p => p.name === projectName)) {
    throw new Error(`Project name already taken: ${projectName}`);
  }

  const project: Project = {
    name: projectName,
    path: absPath,
    registeredAt: new Date().toISOString(),
  };
  projects.push(project);
  await saveProjects(projects);
  return project;
}

export async function removeProject(name: string): Promise<void> {
  const projects = await loadProjects();
  const filtered = projects.filter(p => p.name !== name);
  if (filtered.length === projects.length) {
    throw new Error(`Project not found: ${name}`);
  }
  await saveProjects(filtered);
}
