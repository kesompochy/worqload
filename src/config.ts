import { homedir } from "node:os";
import { join } from "node:path";

// `~/.config/worqload/config.yaml` — the single config file the human edits.
// Resolved per call so a changed $HOME (tests) is honoured.
export function defaultConfigPath(): string {
  return join(homedir(), ".config", "worqload", "config.yaml");
}

export async function loadProtocolPrefix(configPath: string): Promise<string | null> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return null;
  return parseProtocolPrefix(await file.text());
}

export function parseProtocolPrefix(yamlText: string): string | null {
  const parsed = Bun.YAML.parse(yamlText) as unknown;
  if (parsed == null) return null;
  if (typeof parsed !== "object") {
    throw new Error("config: top level must be a YAML mapping");
  }
  const raw = (parsed as Record<string, unknown>).protocolPrefix;
  if (raw == null) return null;
  if (typeof raw !== "string" || raw === "") {
    throw new Error("config: `protocolPrefix` must be a non-empty string");
  }
  return raw;
}
