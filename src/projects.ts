import { homedir } from "os";
import { join, resolve, basename, dirname } from "path";
import { mkdir } from "node:fs/promises";

export interface Project {
  name: string;
  path: string;
  registeredAt: string;
}

const DEFAULT_PROJECTS_PATH = join(homedir(), ".worqload", "projects.json");

async function ensureParentDir(filePath: string): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
  } catch {}
}

export async function loadProjects(projectsPath: string = DEFAULT_PROJECTS_PATH): Promise<Project[]> {
  await ensureParentDir(projectsPath);
  const file = Bun.file(projectsPath);
  if (!(await file.exists())) return [];
  return await file.json();
}

async function saveProjects(projects: Project[], projectsPath: string): Promise<void> {
  await ensureParentDir(projectsPath);
  await Bun.write(projectsPath, JSON.stringify(projects, null, 2));
}

export async function registerProject(projectPath: string, name?: string, projectsPath: string = DEFAULT_PROJECTS_PATH): Promise<Project> {
  const absPath = resolve(projectPath);
  const projectName = name || basename(absPath);

  const projects = await loadProjects(projectsPath);
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
  await saveProjects(projects, projectsPath);
  return project;
}

export async function removeProject(name: string, projectsPath: string = DEFAULT_PROJECTS_PATH): Promise<void> {
  const projects = await loadProjects(projectsPath);
  const filtered = projects.filter(p => p.name !== name);
  if (filtered.length === projects.length) {
    throw new Error(`Project not found: ${name}`);
  }
  await saveProjects(filtered, projectsPath);
}
