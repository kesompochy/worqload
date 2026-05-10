import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

interface Stoppable {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

interface RunnerLike {
  kill(signal?: NodeJS.Signals | number): void;
  exited: Promise<number>;
}

const tmpDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

export function makeTmpDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `worqload-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

export function trackTmpDir(dir: string): void {
  tmpDirs.push(dir);
}

export function trackCleanup(fn: () => Promise<void>): void {
  cleanups.push(fn);
}

const KILL_GRACE_MS = 200;

async function killProcessGracefully(p: Subprocess): Promise<void> {
  if (p.exitCode !== null) return;
  try { p.kill("SIGTERM"); } catch { /* already dead */ }
  const timer = new Promise<"timeout">(r => setTimeout(() => r("timeout"), KILL_GRACE_MS));
  const result = await Promise.race([p.exited, timer]);
  if (result === "timeout") {
    try { p.kill("SIGKILL"); } catch {}
    await p.exited.catch(() => {});
  }
}

export function trackSubprocess<T extends Subprocess>(p: T): T {
  trackCleanup(() => killProcessGracefully(p));
  return p;
}

export function trackServer<T extends Stoppable>(s: T): T {
  trackCleanup(async () => { try { await s.stop(true); } catch {} });
  return s;
}

export function trackRunner(r: RunnerLike): void {
  trackCleanup(async () => {
    try { r.kill("SIGKILL"); } catch {}
    await r.exited.catch(() => {});
  });
}

export async function cleanupAll(): Promise<void> {
  // Run cleanups in reverse order so dependent resources unwind correctly
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      try { await fn(); } catch {}
    }
  }
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
}
