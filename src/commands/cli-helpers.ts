export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`environment variable ${name} is not set`);
    process.exit(2);
  }
  return v;
}

export function requireFlag(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i === -1 || !args[i + 1]) {
    console.error(`${flag} <value> is required`);
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
