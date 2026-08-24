import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SessionCreateHook {
  directory: string;
  commands: string[];
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function parseSessionCreateHooks(yamlText: string): SessionCreateHook[] {
  const parsed = Bun.YAML.parse(yamlText) as unknown;
  if (parsed == null) return [];
  if (typeof parsed !== "object") {
    throw new Error("config: top level must be a YAML mapping");
  }
  const raw = (parsed as Record<string, unknown>).onSessionCreate;
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("config: `onSessionCreate` must be a list of { directory, commands } entries");
  }
  return raw.map((entry, index) => {
    if (entry == null || typeof entry !== "object") {
      throw new Error(`config: onSessionCreate entry ${index} must be a mapping with directory and commands`);
    }
    const { directory, commands } = entry as Record<string, unknown>;
    if (typeof directory !== "string" || directory === "") {
      throw new Error(`config: onSessionCreate entry ${index} is missing a non-empty directory`);
    }
    if (!Array.isArray(commands) || commands.length === 0) {
      throw new Error(`config: onSessionCreate entry ${index} is missing a non-empty commands list`);
    }
    const parsedCommands = commands.map((cmd, cmdIndex) => {
      if (typeof cmd !== "string" || cmd === "") {
        throw new Error(`config: onSessionCreate entry ${index} command at index ${cmdIndex} must be a non-empty string`);
      }
      return cmd;
    });
    return { directory, commands: parsedCommands };
  });
}

export async function loadSessionCreateHooks(configPath: string): Promise<SessionCreateHook[]> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return [];
  return parseSessionCreateHooks(await file.text());
}

function expandTilde(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

function normalizeDir(path: string): string {
  const expanded = expandTilde(path);
  const resolved = resolve(expanded);
  return resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

export function matchingCommands(hooks: SessionCreateHook[], repoDir: string): string[] {
  const normalizedRepo = normalizeDir(repoDir);
  const commands: string[] = [];
  for (const hook of hooks) {
    if (normalizeDir(hook.directory) === normalizedRepo) {
      commands.push(...hook.commands);
    }
  }
  return commands;
}

export async function runCommands(commands: string[], cwd: string): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const command of commands) {
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    results.push({ command, exitCode, stdout, stderr });
  }
  return results;
}

export async function runSessionCreateHooks(
  configPath: string,
  repoDir: string,
  worktreePath: string,
): Promise<CommandResult[]> {
  const hooks = await loadSessionCreateHooks(configPath);
  const commands = matchingCommands(hooks, repoDir);
  if (commands.length === 0) return [];
  return runCommands(commands, worktreePath);
}
