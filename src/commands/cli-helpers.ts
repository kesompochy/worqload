import { readFileSync } from "node:fs";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`environment variable ${name} is not set`);
    process.exit(2);
  }
  return v;
}

// Resolves the serve base URL the agent CLI should talk to. WORQLOAD_ENDPOINT_FILE
// (a path serve rewrites on every (re)connect) wins so the agent follows serve
// across a restart that lands on a different port; WORQLOAD_ENDPOINT is the
// bootstrap-time fallback.
export function resolveAgentEndpoint(): string {
  const file = process.env.WORQLOAD_ENDPOINT_FILE;
  if (file) {
    try {
      const fromFile = readFileSync(file, "utf8").trim();
      if (fromFile !== "") return fromFile;
    } catch {
      // file not written yet (initial spawn window) — fall through to env
    }
  }
  return requireEnv("WORQLOAD_ENDPOINT");
}

export function requireFlag(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i === -1 || !args[i + 1]) {
    console.error(`${flag} <value> is required`);
    process.exit(2);
  }
  return args[i + 1];
}

export function optionalFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  if (!args[i + 1]) {
    console.error(`${flag} <value> requires a value`);
    process.exit(2);
  }
  return args[i + 1];
}

export function exitWithUsage(usage: string): never {
  console.error(`usage: ${usage}`);
  process.exit(2);
}

export async function readAllStdin(): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
  }
  buf += decoder.decode();
  return buf;
}
