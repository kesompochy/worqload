// worqload preview — run THIS checkout against a throwaway scratch repo so a
// branch's UI can be tried before merging without touching the real worqload
// checkout's .worqload/ state.
//
// Run it from inside the worktree under test (`bun run preview`, or
// `bun src/cli.ts preview`) — not via a `bun link`ed `worqload` on PATH. The
// point is to exercise this checkout's code, so the per-session host is pointed
// back at this repo's src/cli.ts (production serve uses the `worqload` on PATH).

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildWebFrontend, webFrontendBuilt } from "../web-build";
import { startServer } from "../web-server";
import { openInBrowser } from "./serve";

// preview.ts lives at <repoRoot>/src/commands/preview.ts.
const repoRoot = join(import.meta.dir, "..", "..");
// Seed contents for a fresh preview repo, curated in the worqload repo itself.
const seedDir = join(repoRoot, "preview-seed");
// Curated example sessions that land in <previewRepo>/.worqload/sessions/ —
// not part of the preview repo's committed tree, so they're excluded from the
// initial `cp` and installed separately after the seed commit.
const mockSessionsSrc = join(seedDir, "mock-sessions");

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

async function runOutput(cmd: string, args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    throw new Error(`${cmd} ${args.join(" ")} failed: ${stderr}`);
  }
  return out.trim();
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
  if (existsSync(seedDir)) {
    await cp(seedDir, repoDir, {
      recursive: true,
      // mock-sessions/ is staging for the .worqload/ sessions layout, not the
      // preview repo's tracked content; install it separately after the commit.
      filter: (src) => src !== mockSessionsSrc,
    });
  }
  await run("git", ["init", "-q", "-b", "main"], repoDir);
  await run("git", ["add", "-A"], repoDir);
  // --no-verify: a throwaway local repo should not be subject to the user's
  // global commit hooks (e.g. branch-protection hooks that block commits to
  // main/master).
  await run("git", ["commit", "--no-verify", "-q", "-m", "seed preview repo"], repoDir);
  await installMockSessions(repoDir);
}

// For each preview-seed/mock-sessions/<id>/, materialise the session under
// <repoDir>/.worqload/sessions/<id>/ and — when the seed carries a `worktree/`
// overlay — a real git branch + worktree off main so the Diff tab has content
// to show. meta.json placeholders __REPO_DIR__ and __BASE_COMMIT__ are
// substituted with the actual worktree path and main's HEAD sha.
async function installMockSessions(repoDir: string): Promise<void> {
  if (!existsSync(mockSessionsSrc)) return;
  const targetRoot = join(repoDir, ".worqload", "sessions");
  await mkdir(targetRoot, { recursive: true });
  const baseCommit = await runOutput("git", ["rev-parse", "HEAD"], repoDir);
  for (const id of await readdir(mockSessionsSrc)) {
    const srcDir = join(mockSessionsSrc, id);
    if (!(await stat(srcDir)).isDirectory()) continue;
    await installMockSession(srcDir, join(targetRoot, id), repoDir, id, baseCommit);
  }
}

async function installMockSession(
  srcDir: string,
  destSessionDir: string,
  repoDir: string,
  id: string,
  baseCommit: string,
): Promise<void> {
  const overlayDir = join(srcDir, "worktree");
  const metaRaw = await Bun.file(join(srcDir, "meta.json")).text();
  const meta = JSON.parse(metaRaw) as { branchName: string; title?: string; prompt: string };

  let worktreePath = repoDir;
  if (existsSync(overlayDir)) {
    const shortId = id.slice(0, 8);
    worktreePath = join(repoDir, ".worktrees", shortId);
    const message = (meta.title?.trim() || meta.prompt.slice(0, 60)).trim();
    await run("git", ["worktree", "add", "-b", meta.branchName, worktreePath, "main"], repoDir);
    await cp(overlayDir, worktreePath, { recursive: true, force: true });
    await run("git", ["add", "-A"], worktreePath);
    await run("git", ["commit", "--no-verify", "-q", "-m", message], worktreePath);
  }

  await mkdir(destSessionDir, { recursive: true });
  for (const name of await readdir(srcDir)) {
    if (name === "worktree") continue;
    const s = join(srcDir, name);
    const d = join(destSessionDir, name);
    const st = await stat(s);
    if (st.isDirectory()) {
      await mkdir(d, { recursive: true });
      await cp(s, d, { recursive: true });
    } else if (name === "meta.json") {
      await Bun.write(d, metaRaw.replaceAll("__REPO_DIR__", worktreePath).replaceAll("__BASE_COMMIT__", baseCommit));
    } else {
      await cp(s, d);
    }
  }
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

  // Record this server's pid so `worqload`'s Preview/Stop-preview actions (and a
  // human) can find and stop it; startServer has already created .worqload/.
  const pidPath = join(repoDir, ".worqload", "preview.pid");
  writeFileSync(pidPath, String(process.pid));
  const removePidFile = () => {
    try { unlinkSync(pidPath); } catch { /* already gone */ }
  };
  process.on("exit", removePidFile);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      removePidFile();
      process.exit(0);
    });
  }
  console.log(`worqload preview listening on ${ctx.baseUrlForAgent}`);
  console.log(`preview repo: ${ctx.repoDir}`);
  console.log(`host command: ${hostCommand.join(" ")}`);

  if (!noOpen) openInBrowser(ctx.baseUrlForAgent);

  // keep the process alive
  await new Promise(() => {});
}
