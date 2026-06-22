import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillButton {
  name: string;
  description?: string;
  sourcePath: string;
}

export function parseSkillPaths(yamlText: string): string[] {
  const parsed = Bun.YAML.parse(yamlText) as unknown;
  if (parsed == null) return [];
  if (typeof parsed !== "object") {
    throw new Error("config: top level must be a YAML mapping");
  }
  const raw = (parsed as Record<string, unknown>).skillPaths;
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("config: `skillPaths` must be a list of directory paths");
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "string" || entry === "") {
      throw new Error(`config: skillPaths entry ${index} must be a non-empty string`);
    }
    return entry;
  });
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    const parsed = Bun.YAML.parse(match[1]);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function scanSkillDirectory(dirPath: string): Promise<SkillButton[]> {
  if (!existsSync(dirPath)) return [];
  const skills: SkillButton[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const entryPath = join(dirPath, entry);
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillFile = join(entryPath, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let content: string;
    try {
      content = readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(content);
    const name = typeof fm.name === "string" && fm.name !== "" ? fm.name : entry;
    const description = typeof fm.description === "string" && fm.description !== "" ? fm.description : undefined;
    skills.push({ name, description, sourcePath: skillFile });
  }
  return skills;
}

function expandTilde(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

export async function loadSkillButtons(configPath: string): Promise<SkillButton[]> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return [];
  const paths = parseSkillPaths(await file.text());
  const seen = new Set<string>();
  const buttons: SkillButton[] = [];
  for (const rawPath of paths) {
    const resolved = expandTilde(rawPath);
    const skills = await scanSkillDirectory(resolved);
    for (const skill of skills) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      buttons.push(skill);
    }
  }
  return buttons;
}
