import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function init(args: string[]): Promise<void> {
  const target = resolve(args[0] ?? ".");
  const worqloadDir = join(target, ".worqload");
  await mkdir(join(worqloadDir, "sessions"), { recursive: true });
  console.log(`Initialized: ${worqloadDir}/`);
}
