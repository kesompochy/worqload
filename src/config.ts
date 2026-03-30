const DEFAULT_CONFIG_PATH = ".worqload/config.json";

export interface SpawnHooks {
  pre?: string[];
  post?: string[];
}

export interface WorkqloadConfig {
  spawn?: SpawnHooks;
}

export async function loadConfig(path: string = DEFAULT_CONFIG_PATH): Promise<WorkqloadConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  return await file.json();
}
