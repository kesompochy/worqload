import { normalizeDir } from "./hooks";

// Which kb-repomap KB a session launches with, as the arguments to
// `kb NAME [--file F] [--store S] [--remote] claude ...`.
export interface KbLaunch {
  name: string;
  file?: string;
  store?: string;
  remote?: boolean;
}

// The KB a repository offers to its sessions. Whether a session actually uses
// it is chosen per session at creation.
export interface KbBinding extends KbLaunch {
  directory: string;
}

export function parseKbBindings(yamlText: string): KbBinding[] {
  const parsed = Bun.YAML.parse(yamlText) as unknown;
  if (parsed == null) return [];
  if (typeof parsed !== "object") {
    throw new Error("config: top level must be a YAML mapping");
  }
  const raw = (parsed as Record<string, unknown>).kb;
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("config: `kb` must be a list of { directory, name } entries");
  }
  return raw.map((entry, index) => {
    if (entry == null || typeof entry !== "object") {
      throw new Error(`config: kb entry ${index} must be a mapping with directory and name`);
    }
    const { directory, name, file, store, remote } = entry as Record<string, unknown>;
    if (typeof directory !== "string" || directory === "") {
      throw new Error(`config: kb entry ${index} is missing a non-empty directory`);
    }
    if (typeof name !== "string" || name === "") {
      throw new Error(`config: kb entry ${index} is missing a non-empty name`);
    }
    for (const [key, value] of [["file", file], ["store", store]] as const) {
      if (value != null && (typeof value !== "string" || value === "")) {
        throw new Error(`config: kb entry ${index} ${key} must be a non-empty string`);
      }
    }
    if (remote != null && typeof remote !== "boolean") {
      throw new Error(`config: kb entry ${index} remote must be a boolean`);
    }
    return {
      directory,
      name,
      ...(file != null && { file: file as string }),
      ...(store != null && { store: store as string }),
      ...(remote != null && { remote }),
    };
  });
}

export async function loadKbBindings(configPath: string): Promise<KbBinding[]> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return [];
  return parseKbBindings(await file.text());
}

export function matchingKbBinding(bindings: KbBinding[], repoDir: string): KbBinding | undefined {
  const normalizedRepo = normalizeDir(repoDir);
  return bindings.find((binding) => normalizeDir(binding.directory) === normalizedRepo);
}

// `claudeCommand` starts with the `claude` binary; kb execs `claude` itself
// and forwards everything after it.
export function wrapClaudeCommandWithKb(claudeCommand: string[], kb: KbLaunch): string[] {
  return [
    "kb",
    kb.name,
    ...(kb.file ? ["--file", kb.file] : []),
    ...(kb.store ? ["--store", kb.store] : []),
    ...(kb.remote ? ["--remote"] : []),
    ...claudeCommand,
  ];
}

export function kbLaunchOf({ directory: _directory, ...launch }: KbBinding): KbLaunch {
  return launch;
}
