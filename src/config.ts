import { loadJsonFile } from "./utils/json-store";

const DEFAULT_CONFIG_PATH = ".worqload/config.json";

export interface SpawnHooks {
  pre?: string[];
  post?: string[];
}

export interface InitConfig {
  agentPath?: string;
  agentTemplate?: string;
}

export interface WorkqloadConfig {
  spawn?: SpawnHooks;
  init?: InitConfig;
  onDone?: string[];
}

export async function loadConfig(path: string = DEFAULT_CONFIG_PATH): Promise<WorkqloadConfig> {
  return loadJsonFile<WorkqloadConfig>(path, {});
}
