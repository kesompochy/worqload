import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function init(args: string[]): Promise<void> {
  const target = resolve(args[0] ?? ".");
  const worqloadDir = join(target, ".worqload");
  await mkdir(join(worqloadDir, "sessions"), { recursive: true });
  // sessions/ is the only subtree worqload needs to exist up front; everything
  // else under .worqload/ is created lazily on first use.
  console.log(`Initialized: ${worqloadDir}/`);
}
