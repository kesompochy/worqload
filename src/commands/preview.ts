// worqload preview — run THIS checkout against a throwaway scratch repo so a
// branch's UI can be tried before merging without touching the real worqload
// checkout's .worqload/ state.
//
// Run it from inside the worktree under test (`bun run preview`, or
// `bun src/cli.ts preview`) — not via a `bun link`ed `worqload` on PATH. The
// point is to exercise this checkout's code, so the per-session host is pointed
// back at this repo's src/cli.ts (production serve uses the `worqload` on PATH).

import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildWebFrontend, webFrontendBuilt } from "../web-build";
import { startServer } from "../web-server";
import { openInBrowser } from "./serve";

// preview.ts lives at <repoRoot>/src/commands/preview.ts.
const repoRoot = join(import.meta.dir, "..", "..");
// Seed contents for a fresh preview repo, curated in the worqload repo itself.
const seedDir = join(repoRoot, "preview-seed");

export function previewRepoDir(env: Record<string, string | undefined>): string {
  const override = env.WORQLOAD_PREVIEW_REPO?.trim();
  if (override) return override;
  return join(env.HOME || homedir(), ".worqload-preview");
}

export function previewHostCommand(execPath: string, repoRootDir: string): string[] {
  return [execPath, join(repoRootDir, "src", "cli.ts"), "session-host"];
}

async function run(cmd: string, args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    throw new Error(`${cmd} ${args.join(" ")} failed: ${stderr}`);
  }
}

// Ensures repoDir is a git repo seeded from preview-seed/. An existing repo is
// reused as-is (keeping its sessions and worktrees) unless reset is requested;
// worqload makes session worktrees off its HEAD branch, so the seed must carry
// at least one commit.
async function ensurePreviewRepo(repoDir: string, opts: { reset: boolean }): Promise<void> {
  if (opts.reset) {
    await rm(repoDir, { recursive: true, force: true });
  } else if (existsSync(repoDir)) {
    if (!existsSync(join(repoDir, ".git"))) {
      throw new Error(`${repoDir} exists but is not a git repo; remove it or rerun with --reset`);
    }
    return;
  }
  await mkdir(repoDir, { recursive: true });
  if (existsSync(seedDir)) await cp(seedDir, repoDir, { recursive: true });
  await run("git", ["init", "-q", "-b", "main"], repoDir);
  await run("git", ["add", "-A"], repoDir);
  // --no-verify: a throwaway local repo should not be subject to the user's
  // global commit hooks (e.g. branch-protection hooks that block commits to
  // main/master).
  await run("git", ["commit", "--no-verify", "-q", "-m", "seed preview repo"], repoDir);
}

export async function preview(args: string[]): Promise<void> {
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const noOpen = flags.has("--no-open");
  const reset = flags.has("--reset");
  const positional = args.filter((a) => !a.startsWith("--"));
  const explicitPort = positional[0] ? Number(positional[0]) : undefined;
  if (explicitPort !== undefined && Number.isNaN(explicitPort)) {
    console.error(`invalid port: ${positional[0]}`);
    process.exit(2);
  }

  const repoDir = previewRepoDir(process.env);
  await ensurePreviewRepo(repoDir, { reset });
  if (!webFrontendBuilt()) await buildWebFrontend();

  const requestedPort = explicitPort ?? 3456;
  const hostCommand = previewHostCommand(process.execPath, repoRoot);
  const { ctx } = await startServer({ port: requestedPort, repoDir, hostCommand });
  if (ctx.port !== requestedPort) {
    console.log(`port ${requestedPort} was in use; using ${ctx.port} instead`);
  }
  console.log(`worqload preview listening on ${ctx.baseUrlForAgent}`);
  console.log(`preview repo: ${ctx.repoDir}`);
  console.log(`host command: ${hostCommand.join(" ")}`);

  if (!noOpen) openInBrowser(ctx.baseUrlForAgent);

  // keep the process alive
  await new Promise(() => {});
}
