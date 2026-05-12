// The browser frontend is built by Vite (see vite.config.ts) into web/dist/.
// The server serves that directory; `bun run web:build` (or `bun run dev`)
// produces it. These helpers let the server fail with a clear message when the
// build is missing, and let the test suite build on demand.
import { existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const distIndexHtml = join(repoRoot, "web", "dist", "index.html");

export function webFrontendBuilt(): boolean {
  return existsSync(distIndexHtml);
}

// Concurrent callers (e.g. several test files) share one in-flight build rather
// than racing to write web/dist/.
let inFlightBuild: Promise<void> | null = null;

export function buildWebFrontend(): Promise<void> {
  if (!inFlightBuild) {
    inFlightBuild = (async () => {
      const { build } = await import("vite");
      await build({ configFile: join(repoRoot, "vite.config.ts"), logLevel: "warn" });
    })();
  }
  return inFlightBuild;
}
