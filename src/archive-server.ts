import type { Server } from "bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { openArchiveDb, defaultArchiveDbPath, listAllSessions, listAllReports, listAllFeedback, listReports, listFeedback } from "./archive-store";
import type { Database } from "bun:sqlite";

const REPO_ROOT = join(import.meta.dir, "..");
const ARCHIVE_DIST_DIR = join(REPO_ROOT, "web", "archive", "dist");
const ARCHIVE_DIST_INDEX = join(ARCHIVE_DIST_DIR, "index.html");

export function archiveFrontendBuilt(): boolean {
  return existsSync(ARCHIVE_DIST_INDEX);
}

let inFlightBuild: Promise<void> | null = null;

export function buildArchiveFrontend(): Promise<void> {
  if (!inFlightBuild) {
    inFlightBuild = (async () => {
      const { build } = await import("vite");
      await build({ configFile: join(REPO_ROOT, "vite.archive.config.ts"), logLevel: "warn" });
    })();
  }
  return inFlightBuild;
}

export async function watchArchiveFrontend(): Promise<void> {
  const { build } = await import("vite");
  const watcher = await build({
    configFile: join(REPO_ROOT, "vite.archive.config.ts"),
    logLevel: "warn",
    build: { watch: {} },
  });
  await new Promise<void>((resolve) => {
    if (!("on" in watcher)) { resolve(); return; }
    watcher.on("event", (e: { code: string }) => {
      if (e.code === "BUNDLE_END") resolve();
    });
  });
}

export interface ArchiveServerContext {
  db: Database;
  staticDir: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function handleRequest(req: Request, ctx: ArchiveServerContext): Response {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/sessions") {
    const repo = url.searchParams.get("repo") ?? undefined;
    const sessions = listAllSessions(ctx.db, repo ? { repo } : undefined);
    return json({ sessions });
  }

  if (req.method === "GET") {
    const sessionReports = path.match(/^\/api\/sessions\/([^/]+)\/reports$/);
    if (sessionReports) {
      const reports = listReports(ctx.db, decodeURIComponent(sessionReports[1]));
      return json({ reports });
    }

    const sessionFeedback = path.match(/^\/api\/sessions\/([^/]+)\/feedback$/);
    if (sessionFeedback) {
      const feedback = listFeedback(ctx.db, decodeURIComponent(sessionFeedback[1]));
      return json({ feedback });
    }

    if (path === "/api/reports") {
      const repo = url.searchParams.get("repo") ?? undefined;
      const reports = listAllReports(ctx.db, repo ? { repo } : undefined);
      return json({ reports });
    }

    if (path === "/api/feedback") {
      const repo = url.searchParams.get("repo") ?? undefined;
      const feedback = listAllFeedback(ctx.db, repo ? { repo } : undefined);
      return json({ feedback });
    }
  }

  if (path === "/") {
    const indexPath = join(ctx.staticDir, "index.html");
    if (existsSync(indexPath)) {
      return new Response(Bun.file(indexPath), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  }

  const assetMatch = path.match(/^\/assets\/([A-Za-z0-9._-]+)$/);
  if (assetMatch) {
    const filename = assetMatch[1];
    const file = Bun.file(join(ctx.staticDir, "assets", filename));
    if (existsSync(join(ctx.staticDir, "assets", filename))) {
      return new Response(file);
    }
  }

  return json({ error: "not found" }, 404);
}

const PORT_FALLBACK_ATTEMPTS = 50;

function listenWithFallback(requestedPort: number, listen: (port: number) => Server): Server {
  if (requestedPort === 0) return listen(0);
  let port = requestedPort;
  for (let attempt = 0; attempt < PORT_FALLBACK_ATTEMPTS; attempt++) {
    try {
      return listen(port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") throw err;
      port++;
    }
  }
  throw new Error(`no free port found in range ${requestedPort}-${requestedPort + PORT_FALLBACK_ATTEMPTS - 1}`);
}

export interface StartArchiveServerOptions {
  port?: number;
  archiveDbPath?: string;
  watch?: boolean;
}

export async function startArchiveServer(opts: StartArchiveServerOptions = {}): Promise<{
  server: Server;
  ctx: ArchiveServerContext;
  shutdown: () => void;
}> {
  const dbPath = opts.archiveDbPath ?? defaultArchiveDbPath();
  const db = openArchiveDb(dbPath);
  if (opts.watch) {
    await watchArchiveFrontend();
  } else if (!archiveFrontendBuilt()) {
    await buildArchiveFrontend();
  }
  const staticDir = ARCHIVE_DIST_DIR;

  const ctx: ArchiveServerContext = { db, staticDir };

  const server = listenWithFallback(opts.port ?? 3457, port => Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      return handleRequest(req, ctx);
    },
  }));

  function shutdown() {
    try { db.close(); } catch { /* best-effort */ }
    server.stop(true);
  }

  return { server, ctx, shutdown };
}
