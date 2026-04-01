import { TaskQueue } from "./queue";
import type { Task } from "./task";
import { createTask } from "./task";
import { loadPrinciples, parsePrincipleLines, addPrinciple, editPrinciple, removePrinciple } from "./principles";
import { loadSpawns } from "./spawns";
import type { SpawnRecord } from "./spawns";
import type { RunnerState } from "./mission-runner-state";
import { loadFeedback, addFeedback, removeFeedback, updateFeedbackMessage } from "./feedback";
import type { Feedback } from "./feedback";
import { loadProjects } from "./projects";
import type { Project } from "./projects";
import { loadReports, updateReportStatus } from "./reports";
import { loadSleep, sleepFor, clearSleep } from "./sleep";
import { generateAgentCard, handleA2ARequest } from "./a2a";
import { loadMissions } from "./mission";
import { loadRunnerStatesUnlocked } from "./mission-runner-state";
import { appendServerLog } from "./server-log";

export interface Route {
  method: string;
  pattern: string | RegExp;
  handler: (req: Request, queue: TaskQueue, port: number, params: string[]) => Promise<Response>;
}

export interface RouteMatch {
  route: Route;
  params: string[];
}

export function matchRoute(method: string, pathname: string, routes: Route[]): RouteMatch | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.pattern === "string") {
      if (pathname === route.pattern) {
        return { route, params: [] };
      }
    } else {
      const match = pathname.match(route.pattern);
      if (match) {
        return { route, params: match.slice(1) };
      }
    }
  }
  return null;
}

const TASK_NOT_FOUND = { error: "Task not found" } as const;
const NOT_WAITING_HUMAN = { error: "Task is not waiting for human" } as const;
const NOT_FAILED = { error: "Task is not failed" } as const;
const PROJECT_NOT_FOUND = { error: "Project not found" } as const;

async function withTask(
  queue: TaskQueue,
  shortId: string,
  handler: (task: Task) => Response | Promise<Response>,
): Promise<Response> {
  await queue.load();
  const task = queue.findById(shortId);
  if (!task) return json(TASK_NOT_FOUND, 404);
  return handler(task);
}

export function startServer(basePort = 3456): void {
  const queue = new TaskQueue();
  const maxAttempts = 10;

  let port = basePort;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      Bun.serve({
        port,
        async fetch(req) {
          const url = new URL(req.url);
          const startTime = Date.now();
          const response = await handleRequest(req, url, queue, port);
          if (url.pathname.startsWith("/api/")) {
            appendServerLog({ method: req.method, path: url.pathname, statusCode: response.status, durationMs: Date.now() - startTime }).catch(() => {});
          }
          return response;
        },
      });

  if (port !== basePort) {
    console.log(`Port ${basePort} in use, using ${port} instead.`);
  }
  console.log(`worqload UI: http://localhost:${port}`);
  return;
    } catch {
      port++;
    }
  }
  console.error(`Could not find an available port (tried ${basePort}-${basePort + maxAttempts - 1}).`);
  process.exit(1);
}

function buildRoutes(): Route[] {
  return [
    { method: "GET", pattern: "/.well-known/agent.json",
      handler: async (_req, _queue, port) => json(generateAgentCard(`http://localhost:${port}`)) },

    { method: "POST", pattern: "/a2a",
      handler: async (req, queue) => json(await handleA2ARequest(queue, await req.json())) },

    { method: "GET", pattern: "/",
      handler: async () => new Response(html(), { headers: { "Content-Type": "text/html; charset=utf-8" } }) },

    { method: "GET", pattern: "/api/tasks",
      handler: async (_req, queue) => { await queue.load(); return json(queue.list()); } },

    { method: "GET", pattern: "/api/history",
      handler: async (_req, queue) => json(await queue.history()) },

    { method: "GET", pattern: "/api/heartbeat",
      handler: async () => {
        const file = Bun.file(".worqload/heartbeat.json");
        if (!(await file.exists())) return json(null);
        return json(await file.json());
      } },

    { method: "GET", pattern: "/api/sleep",
      handler: async () => json(await loadSleep()) },

    { method: "POST", pattern: "/api/sleep",
      handler: async (req) => {
        const body = await req.json() as { minutes: number };
        return json(await sleepFor(body.minutes), 201);
      } },

    { method: "DELETE", pattern: "/api/sleep",
      handler: async () => { await clearSleep(); return json({ cleared: true }); } },

    { method: "GET", pattern: "/api/principles",
      handler: async () => {
        const content = await loadPrinciples();
        return json(parsePrincipleLines(content).map(l => l.slice(2)));
      } },

    { method: "POST", pattern: "/api/principles",
      handler: async (req) => {
        const body = await req.json() as { text: string };
        return json(await addPrinciple(body.text), 201);
      } },

    { method: "PATCH", pattern: /^\/api\/principles\/(\d+)$/,
      handler: async (req, _queue, _port, params) => {
        const body = await req.json() as { text: string };
        return json(await editPrinciple(Number(params[0]), body.text));
      } },

    { method: "DELETE", pattern: /^\/api\/principles\/(\d+)$/,
      handler: async (_req, _queue, _port, params) => {
        return json(await removePrinciple(Number(params[0])));
      } },

    { method: "GET", pattern: "/api/spawns",
      handler: async () => json(filterSpawnsForDashboard(await loadSpawns())) },

    { method: "GET", pattern: "/api/missions",
      handler: async (_req, queue) => {
        await queue.load();
        const missions = await loadMissions();
        const tasks = queue.list();
        const spawns = await loadSpawns();
        return json(missions.map(m => ({
          ...m,
          taskCount: tasks.filter(t => t.missionId === m.id).length,
          tasks: tasks.filter(t => t.missionId === m.id).map(t => ({
            ...t,
            spawns: spawns.filter(s => s.taskId === t.id),
          })),
        })));
      } },

    { method: "GET", pattern: "/api/mission-runners",
      handler: async () => json(filterRunnersForDashboard(await loadRunnerStatesUnlocked())) },

    { method: "GET", pattern: "/api/projects",
      handler: async () => json(await buildProjectsSummary(await loadProjects())) },

    { method: "GET", pattern: "/api/projects/feedback",
      handler: async () => json(await loadAllProjectFeedback(await loadProjects())) },

    { method: "GET", pattern: "/api/feedback",
      handler: async () => json(await loadFeedback()) },

    { method: "POST", pattern: "/api/feedback",
      handler: async (req) => {
        const body = await req.json() as { message: string; from?: string };
        return json(await addFeedback(body.message, body.from || "web-ui"), 201);
      } },

    { method: "PATCH", pattern: /^\/api\/feedback\/([^/]+)$/,
      handler: async (req, _queue, _port, params) => {
        const body = await req.json() as { message: string };
        await updateFeedbackMessage(params[0], body.message);
        return json({ updated: params[0] });
      } },

    { method: "DELETE", pattern: /^\/api\/feedback\/([^/]+)$/,
      handler: async (_req, _queue, _port, params) => {
        await removeFeedback(params[0]);
        return json({ deleted: params[0] });
      } },

    { method: "GET", pattern: "/api/reports",
      handler: async (req) => {
        const url = new URL(req.url);
        const category = url.searchParams.get("category");
        const reports = await loadReports();
        const filtered = category ? reports.filter(r => r.category === category) : reports;
        return json(filtered);
      } },

    { method: "PATCH", pattern: /^\/api\/reports\/([^/]+)\/status$/,
      handler: async (req, _queue, _port, params) => {
        const body = await req.json() as { status: string };
        await updateReportStatus(params[0], body.status as "unread" | "reading" | "read" | "archived");
        return json({ updated: true });
      } },

    { method: "POST", pattern: /^\/api\/projects\/([^/]+)\/feedback$/,
      handler: async (req, _queue, _port, params) => {
        const projectName = decodeURIComponent(params[0]);
        const projects = await loadProjects();
        const project = projects.find(p => p.name === projectName);
        if (!project) return json(PROJECT_NOT_FOUND, 404);
        const feedbackPath = project.path + "/.worqload/feedback.json";
        const body = await req.json() as { message: string; from?: string };
        return json(await addFeedback(body.message, body.from || "dashboard", feedbackPath), 201);
      } },

    { method: "POST", pattern: "/api/tasks",
      handler: async (req, queue) => {
        await queue.load();
        const body = await req.json() as { title: string; priority?: number; createdBy?: string };
        const task = createTask(body.title, {}, body.priority ?? 0, body.createdBy);
        queue.enqueue(task);
        await queue.save();
        return json(task, 201);
      } },

    { method: "POST", pattern: /^\/api\/tasks\/([^/]+)\/decide$/,
      handler: async (req, queue, _port, params) =>
        withTask(queue, params[0], async (task) => {
          if (task.status !== "waiting_human") return json(NOT_WAITING_HUMAN, 400);
          const body = await req.json() as { decision: string };
          queue.transition(task.id, "orienting");
          queue.addLog(task.id, "orient", body.decision);
          await queue.save();
          return json(queue.get(task.id));
        }) },

    { method: "PATCH", pattern: /^\/api\/tasks\/([^/]+)$/,
      handler: async (req, queue, _port, params) =>
        withTask(queue, params[0], async (task) => {
          const body = await req.json() as { priority?: number; title?: string };
          const patch: Record<string, unknown> = {};
          if (body.priority !== undefined) patch.priority = body.priority;
          if (body.title !== undefined) patch.title = body.title.trim();
          if (Object.keys(patch).length > 0) {
            queue.update(task.id, patch);
            await queue.save();
          }
          return json(queue.get(task.id));
        }) },

    { method: "DELETE", pattern: /^\/api\/tasks\/([^/]+)$/,
      handler: async (_req, queue, _port, params) =>
        withTask(queue, params[0], async (task) => {
          queue.remove(task.id);
          await queue.save();
          return json({ deleted: task.id });
        }) },

    { method: "POST", pattern: /^\/api\/tasks\/([^/]+)\/fail$/,
      handler: async (req, queue, _port, params) =>
        withTask(queue, params[0], async (task) => {
          const body = await req.json() as { reason?: string };
          queue.addLog(task.id, "act", `[FAILED] ${body.reason || "No reason given"}`);
          queue.transition(task.id, "failed");
          await queue.save();
          return json(queue.get(task.id));
        }) },

    { method: "POST", pattern: "/api/clean",
      handler: async (_req, queue) => {
        await queue.load();
        const terminatedIds = queue.list()
          .filter(t => t.status === "done" || t.status === "failed")
          .map(t => t.id);
        if (terminatedIds.length === 0) return json({ archived: [] });
        const archived = await queue.archive(terminatedIds);
        await queue.save();
        return json({ archived: archived.map(t => t.id) });
      } },

    { method: "POST", pattern: /^\/api\/tasks\/([^/]+)\/retry$/,
      handler: async (_req, queue, _port, params) =>
        withTask(queue, params[0], async (task) => {
          if (task.status !== "failed") return json(NOT_FAILED, 400);
          queue.addLog(task.id, "act", "[RETRY]");
          queue.transition(task.id, "observing");
          await queue.save();
          return json(queue.get(task.id));
        }) },
  ];
}

const apiRoutes = buildRoutes();

async function handleRequest(req: Request, url: URL, queue: TaskQueue, port: number): Promise<Response> {
  const matched = matchRoute(req.method, url.pathname, apiRoutes);
  if (matched) {
    return matched.route.handler(req, queue, port, matched.params);
  }
  return new Response("Not Found", { status: 404 });
}

const RECENT_SPAWN_LIMIT = 10;

export function filterSpawnsForDashboard(spawns: SpawnRecord[]): SpawnRecord[] {
  const running = spawns.filter(s => s.status === "running");
  const finished = spawns
    .filter(s => s.status !== "running")
    .sort((a, b) => new Date(b.finishedAt ?? b.startedAt).getTime() - new Date(a.finishedAt ?? a.startedAt).getTime())
    .slice(0, RECENT_SPAWN_LIMIT);
  return [...running, ...finished];
}

export function filterRunnersForDashboard(runners: RunnerState[]): RunnerState[] {
  return runners.filter(r => r.status !== "stopped");
}

export interface ProjectSummary {
  name: string;
  path: string;
  registeredAt: string;
  taskCount: number;
  feedbackCount: number;
}

export async function buildProjectsSummary(projects: Project[]): Promise<ProjectSummary[]> {
  const result: ProjectSummary[] = [];
  for (const p of projects) {
    const tasksFile = Bun.file(p.path + "/.worqload/tasks.json");
    const feedbackFile = Bun.file(p.path + "/.worqload/feedback.json");
    const tasks = (await tasksFile.exists()) ? await tasksFile.json() : [];
    const feedback = (await feedbackFile.exists()) ? await feedbackFile.json() : [];
    result.push({
      name: p.name,
      path: p.path,
      registeredAt: p.registeredAt,
      taskCount: tasks.length,
      feedbackCount: feedback.length,
    });
  }
  return result;
}

export interface ProjectFeedback extends Feedback {
  projectName: string;
}

export async function loadAllProjectFeedback(projects: Project[]): Promise<ProjectFeedback[]> {
  const result: ProjectFeedback[] = [];
  for (const p of projects) {
    const feedbackFile = Bun.file(p.path + "/.worqload/feedback.json");
    if (!(await feedbackFile.exists())) continue;
    const feedback: Feedback[] = await feedbackFile.json();
    for (const fb of feedback) {
      result.push({ ...fb, projectName: p.name });
    }
  }
  return result;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function html(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>worqload</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 1.5rem; }
  h1 { font-size: 1.5rem; color: #fff; }
  h2 { font-size: 1rem; margin: 1rem 0 0.5rem; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }

  .task { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.75rem; margin-bottom: 0.5rem; transition: all 0.3s ease; animation: card-enter 0.3s ease; }
  @keyframes card-enter { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
  .task-title { font-weight: 600; font-size: 0.85rem; word-break: break-word; }
  .task-meta { font-size: 0.7rem; color: #666; margin-top: 0.25rem; }
  .task-owner { font-size: 0.65rem; color: #6cced4; background: #1a2e2e; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .task-created-by { font-size: 0.65rem; color: #b0a0d0; margin-left: 0.3rem; }

  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }
  .badge-waiting { background: #3d1a1a; color: #ed6c6c; animation: pulse 2s infinite; }
  .badge-failed { background: #2e1a1a; color: #d46c6c; }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

  .human-question { background: #2a1a1a; border: 1px solid #4a2a2a; border-radius: 6px; padding: 0.6rem; margin-top: 0.5rem; font-size: 0.8rem; color: #ed9c9c; line-height: 1.4; }
  .human-question-label { font-size: 0.7rem; font-weight: 600; color: #ed6c6c; margin-bottom: 0.25rem; text-transform: uppercase; }
  .human-action { margin-top: 0.5rem; display: flex; gap: 0.25rem; }
  .human-action input { flex: 1; background: #0a0a0a; border: 1px solid #4a2a2a; border-radius: 4px; padding: 0.5rem; color: #e0e0e0; font-size: 0.85rem; min-width: 0; }
  .human-action input:focus { outline: none; border-color: #ed6c6c; }

  .logs { margin-top: 0.4rem; max-height: 6rem; overflow-y: auto; }
  .log { font-size: 0.7rem; color: #888; padding: 0.15rem 0; font-family: monospace; }
  .log-phase { color: #6c7aed; }

  button { background: #2a2a2a; color: #e0e0e0; border: 1px solid #333; border-radius: 4px; padding: 0.4rem 0.75rem; cursor: pointer; font-size: 0.8rem; }
  button:hover { background: #333; }
  button.primary { background: #6c7aed; color: #fff; border-color: #6c7aed; }
  button.primary:hover { background: #5a68d4; }
  button.danger { background: #2e1a1a; color: #d46c6c; border-color: #4a2a2a; }
  button.danger:hover { background: #3d1a1a; }
  button.retry { background: #1a2e1a; color: #6aed6c; border-color: #2a4a2a; }
  button.retry:hover { background: #1a3d1a; }

  .add-form { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .add-form input[type="text"] { flex: 1; background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.6rem; color: #e0e0e0; font-size: 0.9rem; }
  .add-form input[type="text"]:focus { outline: none; border-color: #6c7aed; }

  .principles { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.75rem; margin-bottom: 1rem; }
  .principles ol { padding-left: 1.5rem; }
  .principles li { margin: 0.2rem 0; padding-left: 0.5rem; font-size: 0.85rem; display: flex; align-items: center; gap: 0.4rem; }
  .principles li .principle-text { flex: 1; cursor: pointer; padding: 0.15rem 0.3rem; border-radius: 4px; }
  .principles li .principle-text:hover { background: #1a1a1a; }
  .principles li .principle-actions { display: flex; gap: 0.2rem; opacity: 0; transition: opacity 0.15s; }
  .principles li:hover .principle-actions { opacity: 1; }
  .principles li .principle-actions button { font-size: 0.65rem; padding: 0.1rem 0.3rem; }
  .principle-edit-input { flex: 1; background: #0a0a0a; border: 1px solid #6c7aed; border-radius: 4px; padding: 0.3rem 0.5rem; color: #e0e0e0; font-size: 0.85rem; }
  .principle-edit-input:focus { outline: none; }
  .principle-add { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
  .principle-add input { flex: 1; background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 4px; padding: 0.3rem 0.5rem; color: #e0e0e0; font-size: 0.8rem; }
  .principle-add input:focus { outline: none; border-color: #6c7aed; }

  .empty { color: #444; font-style: italic; font-size: 0.8rem; }

  .tabs { display: flex; gap: 0.25rem; margin-bottom: 1rem; }
  .tab { padding: 0.4rem 1rem; border-radius: 4px 4px 0 0; cursor: pointer; font-size: 0.85rem; background: #161616; border: 1px solid #2a2a2a; border-bottom: none; color: #888; }
  .tab.active { background: #0a0a0a; color: #fff; border-color: #333; }

  .task-actions { display: flex; gap: 0.35rem; margin-top: 0.4rem; align-items: center; flex-wrap: wrap; }
  .task-actions button { font-size: 0.7rem; padding: 0.2rem 0.4rem; }
  .priority-edit { width: 3rem; background: #0a0a0a; border: 1px solid #333; border-radius: 4px; padding: 0.15rem 0.3rem; color: #e0e0e0; font-size: 0.7rem; text-align: center; }
  .priority-edit:focus { outline: none; border-color: #6c7aed; }
  .action-label { font-size: 0.7rem; color: #888; }

  .board { display: flex; gap: 0.75rem; overflow-x: auto; padding-bottom: 1rem; min-height: 300px; }
  .column { flex: 0 0 220px; min-width: 220px; background: #111; border: 1px solid #222; border-radius: 8px; display: flex; flex-direction: column; }
  .column-header { padding: 0.6rem 0.75rem; border-bottom: 1px solid #222; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; display: flex; justify-content: space-between; align-items: center; }
  .column-header .count { font-size: 0.7rem; font-weight: 400; color: #666; background: #1a1a1a; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .column-body { padding: 0.5rem; flex: 1; overflow-y: auto; }

  .col-observe .column-header { color: #6aed6c; border-bottom-color: #2a4a2a; }
  .col-orient .column-header { color: #6aed6c; border-bottom-color: #2a4a2a; }
  .col-decide .column-header { color: #edd76c; border-bottom-color: #4a4a2a; }
  .col-act .column-header { color: #6cced4; border-bottom-color: #2a4a4a; }
  .col-done .column-header { color: #666; border-bottom-color: #222; }

  .spawns { margin-bottom: 1rem; }
  .spawn { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.75rem; }
  .spawn-task { flex: 1; font-weight: 500; font-size: 0.9rem; }
  .spawn-task-id { font-size: 0.65rem; font-family: monospace; color: #888; background: #1a1a2e; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .spawn-owner { font-size: 0.7rem; color: #6cced4; background: #1a2e2e; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .spawn-started-at { font-size: 0.65rem; color: #888; font-family: monospace; white-space: nowrap; }
  .spawn-pid { font-size: 0.7rem; color: #888; font-family: monospace; }
  .spawn-status { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
  .spawn-running { background: #1a2e2e; color: #6cced4; animation: pulse 2s infinite; }
  .spawn-done { background: #1a2e1a; color: #6aed6c; }
  .spawn-failed { background: #2e1a1a; color: #d46c6c; }
  .spawn-duration { font-size: 0.75rem; color: #666; white-space: nowrap; }
  .history-card { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.75rem; margin-bottom: 0.5rem; }
  .history-header { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; }
  .history-header:hover { opacity: 0.85; }
  .history-title { font-weight: 600; font-size: 0.85rem; word-break: break-word; flex: 1; }
  .history-meta { font-size: 0.7rem; color: #666; margin-top: 0.25rem; }
  .history-id { font-size: 0.65rem; font-family: monospace; color: #888; background: #1a1a2e; padding: 0.15rem 0.4rem; border-radius: 3px; cursor: pointer; user-select: all; white-space: nowrap; }
  .history-id:hover { background: #2a2a4e; color: #aaa; }
  .history-id.copied { background: #1a2e1a; color: #6aed6c; }
  .history-expand { font-size: 0.7rem; color: #666; transition: transform 0.2s; }
  .history-logs { margin-top: 0.5rem; border-top: 1px solid #2a2a2a; padding-top: 0.5rem; }
  .history-logs .log { font-size: 0.7rem; color: #888; padding: 0.2rem 0; font-family: monospace; white-space: pre-wrap; word-break: break-word; }
  .history-search { margin-bottom: 0.75rem; display: flex; gap: 0.5rem; }
  .history-search input { flex: 1; background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.5rem; color: #e0e0e0; font-size: 0.85rem; }
  .history-search input:focus { outline: none; border-color: #6c7aed; }

  .report-content h1, .report-content h2, .report-content h3, .report-content h4 { color: #e0e0e0; margin: 0.8em 0 0.4em; }
  .report-content h1 { font-size: 1.2em; } .report-content h2 { font-size: 1.1em; } .report-content h3 { font-size: 1em; }
  .report-content p { margin: 0.4em 0; }
  .report-content ul, .report-content ol { margin: 0.4em 0; padding-left: 1.5em; }
  .report-content code { background: #1a1a2e; padding: 0.15em 0.4em; border-radius: 3px; font-size: 0.9em; }
  .report-content pre { background: #1a1a2e; padding: 0.8em; border-radius: 6px; overflow-x: auto; }
  .report-content pre code { background: none; padding: 0; }
  .report-content table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
  .report-content th, .report-content td { border: 1px solid #333; padding: 0.4em 0.6em; text-align: left; }
  .report-content th { background: #1a1a2e; color: #e0e0e0; }
  .report-content a { color: #6cced4; }
  .report-content blockquote { border-left: 3px solid #444; margin: 0.5em 0; padding-left: 0.8em; color: #999; }
  .report-content strong { color: #e0e0e0; }
</style>
<script type="module">
import { h, render } from 'https://esm.sh/preact@10.25.4';
import { useState, useEffect, useRef, useCallback } from 'https://esm.sh/preact@10.25.4/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
import { marked } from 'https://esm.sh/marked@15.0.7';
marked.setOptions({ breaks: true, gfm: true });
const html = htm.bind(h);

const COLUMNS = [
  { key: 'observe', label: 'Observe', statuses: ['observing'] },
  { key: 'orient', label: 'Orient', statuses: ['orienting'] },
  { key: 'decide', label: 'Decide', statuses: ['deciding', 'waiting_human'] },
  { key: 'act', label: 'Act', statuses: ['acting'] },
  { key: 'done', label: 'Done', statuses: ['done', 'failed'] },
];

const api = {
  get: (url) => fetch(url).then(r => r.json()),
  post: (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  patch: (url, body) => fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  del: (url) => fetch(url, { method: 'DELETE' }),
};

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const hr = Math.floor(m / 60);
  if (hr < 24) return hr + 'h ago';
  return Math.floor(hr / 24) + 'd ago';
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function getHumanQuestion(task) {
  if (task.status !== 'waiting_human') return null;
  for (let i = task.logs.length - 1; i >= 0; i--) {
    const log = task.logs[i];
    if (log.content.startsWith('[HUMAN REQUIRED] ')) return log.content.slice(17);
  }
  return null;
}

function Heartbeat({ heartbeat, sleepState, onUpdate }) {
  const [minutes, setMinutes] = useState(20);
  const [gracefulStop, setGracefulStop] = useState(null);
  const sleeping = sleepState && new Date(sleepState.until).getTime() > Date.now();
  const sleepRemaining = sleeping ? Math.max(0, Math.ceil((new Date(sleepState.until).getTime() - Date.now()) / 1000)) : 0;

  const pause = async () => {
    await api.post('/api/sleep', { minutes });
    onUpdate();
  };
  const wakeUp = async () => {
    await fetch('/api/sleep', { method: 'DELETE' });
    setGracefulStop(null);
    onUpdate();
  };

  const startGracefulStop = async () => {
    await api.post('/api/sleep', { minutes: 60 * 24 });
    onUpdate();
    const poll = async () => {
      const spawns = await api.get('/api/spawns');
      const running = spawns.filter(s => s.status === 'running');
      if (running.length === 0) {
        setGracefulStop(null);
        return;
      }
      setGracefulStop(running.length);
      setTimeout(poll, 3000);
    };
    poll();
  };

  if (sleeping) {
    const rm = Math.floor(sleepRemaining / 60);
    const rs = sleepRemaining % 60;
    const countdownText = (rm > 0 ? rm + 'm ' : '') + rs + 's';
    return html\`<span style="display:inline-flex;align-items:center;gap:0.5rem">
      \${gracefulStop != null
        ? html\`<span style="font-size:0.85rem;color:#e8a55a">Waiting for \${gracefulStop} spawns...</span>\`
        : html\`<span style="font-size:0.85rem;color:#edd76c">Paused: \${countdownText} remaining</span>\`}
      <button style="font-size:0.7rem;padding:0.2rem 0.5rem" onClick=\${wakeUp}>Wake</button>
    </span>\`;
  }

  const heartbeatText = (() => {
    if (!heartbeat) return null;
    const elapsed = Math.floor((Date.now() - new Date(heartbeat.lastRun).getTime()) / 1000);
    const remaining = Math.max(0, heartbeat.intervalSeconds - elapsed);
    const text = remaining === 0 ? 'Loop: running...' : 'Next loop: ' + (remaining >= 60 ? Math.floor(remaining / 60) + 'm ' : '') + (remaining % 60) + 's';
    const color = remaining === 0 ? '#6cced4' : '#888';
    return html\`<span style="font-size:0.85rem;color:\${color}">\${text}</span>\`;
  })();

  return html\`<span style="display:inline-flex;align-items:center;gap:0.5rem">
    \${heartbeatText}
    <input type="number" value=\${minutes} min="1" placeholder="20" style="width:3.5rem;background:#161616;border:1px solid #2a2a2a;border-radius:4px;padding:0.2rem 0.3rem;color:#e0e0e0;font-size:0.75rem;text-align:center"
      onChange=\${(e) => setMinutes(Number(e.target.value) || 1)} /><span style="font-size:0.75rem;color:#888">min</span>
    <button style="font-size:0.7rem;padding:0.2rem 0.5rem" onClick=\${pause}>Pause</button>
    <button style="font-size:0.7rem;padding:0.2rem 0.5rem;color:#e8a55a" onClick=\${startGracefulStop}>Graceful Stop</button>
  </span>\`;
}

function EditableText({ value, onSave, className, inputClassName }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const startEdit = () => { setEditValue(value); setEditing(true); };
  const save = () => {
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); }
    if (e.key === 'Escape') setEditing(false);
  };
  if (editing) {
    return html\`<input value=\${editValue} onInput=\${(e) => setEditValue(e.target.value)} onKeyDown=\${onKeyDown} onBlur=\${save} ref=\${(el) => el && el.focus()} class=\${inputClassName || ''} style="width:100%;box-sizing:border-box" />\`;
  }
  return html\`<span class=\${className || ''} style="cursor:pointer" onClick=\${startEdit}>\${value}</span>\`;
}

function Principles({ items, onUpdate }) {
  const addRef = useRef(null);

  const savePrinciple = async (i, newText) => {
    await api.patch('/api/principles/' + i, { text: newText });
    onUpdate();
  };
  const remove = async (i) => {
    await api.del('/api/principles/' + i);
    onUpdate();
  };
  const add = async () => {
    const text = addRef.current.value.trim();
    if (!text) return;
    await api.post('/api/principles', { text });
    addRef.current.value = '';
    onUpdate();
  };
  const onAddKey = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } };

  return html\`<div class="principles">
    <h2 style="margin-top:0">Principles</h2>
    \${items.length === 0 && html\`<div class="empty">No principles defined.</div>\`}
    <ol>\${items.map((p, i) => html\`<li key=\${i}>
      <\${EditableText} value=\${p} onSave=\${(newText) => savePrinciple(i, newText)} className="principle-text" inputClassName="principle-edit-input" />
      <span class="principle-actions">
        <button class="danger" onClick=\${() => remove(i)}>Del</button>
      </span>
    </li>\`)}</ol>
    <div class="principle-add">
      <input type="text" ref=\${addRef} placeholder="Add a new principle..." onKeyDown=\${onAddKey} />
      <button class="primary" onClick=\${add} style="font-size:0.75rem">Add</button>
    </div>
  </div>\`;
}

function SpawnList({ spawns }) {
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const running = spawns.filter(s => s.status === 'running');
  const recent = spawns.filter(s => s.status !== 'running' && s.finishedAt && new Date(s.finishedAt).getTime() > fiveMinAgo).slice(-10).reverse();
  if (!running.length && !recent.length) return null;
  return html\`<div class="spawns">
    <h2 style="margin-top:0">Spawns</h2>
    \${running.map(s => html\`<\${SpawnRow} key=\${s.id} s=\${s} />\`)}
    \${recent.length > 0 && html\`<div style="margin-top:0.5rem;font-size:0.75rem;color:#666">Recent</div>\`}
    \${recent.map(s => html\`<\${SpawnRow} key=\${s.id} s=\${s} />\`)}
  </div>\`;
}

function SpawnRow({ s }) {
  const dur = s.finishedAt
    ? formatDuration(new Date(s.finishedAt) - new Date(s.startedAt))
    : formatDuration(Date.now() - new Date(s.startedAt)) + '...';
  const startedTime = new Date(s.startedAt).toLocaleTimeString();
  return html\`<div class="spawn">
    <span class="spawn-status spawn-\${s.status}">\${s.status}</span>
    <span class="spawn-task-id">\${s.taskId.slice(0, 8)}</span>
    <span class="spawn-task">\${s.taskTitle}</span>
    <span class="spawn-owner">@\${s.owner}</span>
    <span class="spawn-started-at" title=\${s.startedAt}>\${startedTime}</span>
    <span class="spawn-pid">PID \${s.pid}</span>
    <span class="spawn-duration">\${dur}</span>
  </div>\`;
}

function FeedbackForm({ onSend }) {
  const msgRef = useRef(null);
  const submit = async () => {
    const msg = msgRef.current.value.trim();
    if (!msg) return;
    await api.post('/api/feedback', { message: msg, from: 'dashboard' });
    msgRef.current.value = '';
    onSend();
  };
  const onKey = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (e.shiftKey) submit(); } };
  return html\`<div class="add-form">
    <input type="text" ref=\${msgRef} placeholder="Send feedback to the agent..." onKeyDown=\${onKey} />
    <button class="primary" onClick=\${submit} title="Shift+Enter">Send feedback</button>
  </div>\`;
}

function TaskCard({ task, onUpdate }) {
  const question = getHumanQuestion(task);
  const decideRef = useRef(null);
  const isTerminal = task.status === 'done' || task.status === 'failed';

  const submitDecide = async () => {
    const val = decideRef.current.value.trim();
    if (!val) return;
    await api.post('/api/tasks/' + task.id.slice(0, 8) + '/decide', { decision: val });
    onUpdate();
  };
  const setPriority = async (e) => {
    await api.patch('/api/tasks/' + task.id.slice(0, 8), { priority: Number(e.target.value) || 0 });
    onUpdate();
  };
  const failTask = async () => {
    const reason = prompt('Fail reason:');
    if (reason === null) return;
    await api.post('/api/tasks/' + task.id.slice(0, 8) + '/fail', { reason });
    onUpdate();
  };
  const retryTask = async () => {
    await api.post('/api/tasks/' + task.id.slice(0, 8) + '/retry', {});
    onUpdate();
  };
  const deleteTask = async () => {
    if (!confirm('Delete task: ' + task.title + '?')) return;
    await fetch('/api/tasks/' + task.id.slice(0, 8), { method: 'DELETE' });
    onUpdate();
  };
  const saveTitle = async (newTitle) => {
    await api.patch('/api/tasks/' + task.id.slice(0, 8), { title: newTitle });
    onUpdate();
  };

  return html\`<div class="task" title=\${task.id.slice(0, 8)}>
    <div class="task-title">
      <\${EditableText} value=\${task.title} onSave=\${saveTitle} inputClassName="task-title-edit" />
      \${task.status === 'waiting_human' && html\` <span class="badge badge-waiting">waiting</span>\`}
      \${task.status === 'failed' && html\` <span class="badge badge-failed">failed</span>\`}
      \${task.owner && html\` <span class="task-owner">@\${task.owner}</span>\`}
    </div>
    <div class="task-meta">
      \${timeAgo(task.createdAt)} · p\${task.priority}
      \${task.createdBy && html\` <span class="task-created-by">by \${task.createdBy}</span>\`}
    </div>
    \${question && html\`<div class="human-question">
      <div class="human-question-label">Question</div>
      \${question}
    </div>\`}
    \${task.status === 'waiting_human' && html\`<div class="human-action">
      <input type="text" ref=\${decideRef} placeholder="Your answer..."
        onKeyDown=\${(e) => { if (e.key === 'Enter' && e.shiftKey && !e.isComposing) { e.preventDefault(); submitDecide(); }}} />
      <button class="primary" onClick=\${submitDecide}>Answer</button>
    </div>\`}
    \${task.logs.length > 0 && html\`<div class="logs">
      \${task.logs.map((l, i) => html\`<div class="log" key=\${i}><span class="log-phase">[\${l.phase}]</span> \${l.content}</div>\`)}
    </div>\`}
    \${!isTerminal && html\`<div class="task-actions">
      <label class="action-label">Pri</label>
      <input type="number" class="priority-edit" defaultValue=\${task.priority} key=\${task.id + '-p-' + task.priority} onChange=\${setPriority} />
      <button class="danger" onClick=\${failTask}>Fail</button>
      <button class="danger" onClick=\${deleteTask}>Del</button>
    </div>\`}
    \${task.status === 'failed' && html\`<div class="task-actions">
      <button class="retry" onClick=\${retryTask}>Retry</button>
      <button class="danger" onClick=\${deleteTask}>Del</button>
    </div>\`}
  </div>\`;
}

function HistoryCard({ task }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const shortId = task.id.slice(0, 8);

  const copyId = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(shortId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const statusBadge = task.status === 'failed'
    ? html\` <span class="badge badge-failed">failed</span>\`
    : html\` <span class="badge" style="background:#1a2e1a;color:#6aed6c">done</span>\`;

  return html\`<div class="history-card">
    <div class="history-header" onClick=\${() => setExpanded(!expanded)}>
      <span class="history-expand">\${expanded ? '▼' : '▶'}</span>
      <span class="history-title">\${task.title}\${statusBadge}
        \${task.owner && html\` <span class="task-owner">@\${task.owner}</span>\`}
      </span>
      <span class=\${"history-id" + (copied ? " copied" : "")} onClick=\${copyId} title="Click to copy task ID">\${copied ? 'Copied!' : shortId}</span>
    </div>
    <div class="history-meta">
      \${timeAgo(task.createdAt)} · p\${task.priority}
      \${task.createdBy && html\` <span class="task-created-by">by \${task.createdBy}</span>\`}
    </div>
    \${expanded && task.logs.length > 0 && html\`<div class="history-logs">
      \${task.logs.map((l, i) => html\`<div class="log" key=\${i}><span class="log-phase">[\${l.phase}]</span> \${l.content}</div>\`)}
    </div>\`}
    \${expanded && task.logs.length === 0 && html\`<div class="history-logs"><div class="empty">No logs.</div></div>\`}
  </div>\`;
}

function HistoryView({ history }) {
  const [search, setSearch] = useState('');
  const filtered = search.trim()
    ? history.filter(t => {
        const q = search.trim().toLowerCase();
        return t.title.toLowerCase().includes(q) || t.id.slice(0, 8).includes(q);
      })
    : history;
  const sorted = filtered.slice().reverse();

  return html\`<div>
    <div class="history-search">
      <input type="text" placeholder="Search by title or task ID..." value=\${search} onInput=\${(e) => setSearch(e.target.value)} />
    </div>
    <div class="board"><div class="column" style="flex:1;min-width:auto">
      <div class="column-header">Archived <span class="count">\${filtered.length}\${search.trim() ? ' / ' + history.length : ''}</span></div>
      <div class="column-body">
        \${sorted.length === 0
          ? html\`<div class="empty">\${search.trim() ? 'No matching tasks.' : 'No archived tasks.'}</div>\`
          : sorted.map(t => html\`<\${HistoryCard} key=\${t.id} task=\${t} />\`)}
      </div>
    </div></div>
  </div>\`;
}

function MissionSection({ missions, onUpdate }) {
  const activeMissions = missions.filter(m => m.status === 'active');
  const completedMissions = missions.filter(m => m.status === 'completed');
  if (!missions.length) return null;

  return html\`<div style="margin-bottom:1rem">
    <h2 style="margin-top:0">Missions</h2>
    \${activeMissions.map(m => html\`<\${MissionCard} key=\${m.id} mission=\${m} onUpdate=\${onUpdate} />\`)}
    \${completedMissions.length > 0 && html\`<div style="margin-top:0.5rem;font-size:0.75rem;color:#666">Completed</div>
      \${completedMissions.map(m => html\`<\${MissionCard} key=\${m.id} mission=\${m} onUpdate=\${onUpdate} />\`)}\`}
  </div>\`;
}

function MissionCard({ mission, onUpdate }) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = mission.status === 'active' ? '#6c7aed' : '#666';
  const oodaColors = { observing: '#4caf50', orienting: '#4caf50', deciding: '#ffc107', waiting_human: '#ed6c6c', acting: '#00bcd4', done: '#666', failed: '#d46c6c' };
  const oodaLabels = { observing: 'O', orienting: 'Or', deciding: 'D', waiting_human: 'W', acting: 'A', done: '✓', failed: '✗' };
  const tasksByStatus = {};
  for (const t of mission.tasks) {
    if (!tasksByStatus[t.status]) tasksByStatus[t.status] = 0;
    tasksByStatus[t.status]++;
  }
  return html\`<div class="task" style="border-left:3px solid \${statusColor}">
    <div style="display:flex;align-items:center;gap:0.5rem;cursor:pointer" onClick=\${() => setExpanded(!expanded)}>
      <span style="font-size:0.7rem;color:#666">\${expanded ? '▼' : '▶'}</span>
      <span class="task-title" style="flex:1">\${mission.name}</span>
      <span style="display:flex;gap:0.2rem">\${Object.entries(tasksByStatus).map(([status, count]) =>
        html\`<span key=\${status} class="badge" style="background:\${oodaColors[status]}20;color:\${oodaColors[status]};font-size:0.6rem;padding:0.1rem 0.35rem">\${oodaLabels[status]}\${count > 1 ? count : ''}</span>\`
      )}</span>
      <span class="badge" style="background:\${statusColor}20;color:\${statusColor}">\${mission.status}</span>
      <span class="count" style="font-size:0.7rem;color:#888">\${mission.taskCount} tasks</span>
    </div>
    \${expanded && html\`<div style="margin-top:0.5rem;border-top:1px solid #2a2a2a;padding-top:0.5rem">
      \${mission.tasks.length === 0
        ? html\`<div class="empty">No tasks assigned.</div>\`
        : html\`<div style="display:flex;gap:0.5rem;overflow-x:auto;padding-bottom:0.5rem">
            \${COLUMNS.map(col => {
              const colTasks = mission.tasks.filter(t => col.statuses.includes(t.status));
              if (colTasks.length === 0 && col.key === 'done') return null;
              return html\`<div class="col-\${col.key}" key=\${col.key} style="flex:0 0 200px;min-width:200px;background:#111;border:1px solid #222;border-radius:6px;display:flex;flex-direction:column">
                <div class="column-header" style="padding:0.4rem 0.6rem;border-bottom:1px solid #222;font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;display:flex;justify-content:space-between;align-items:center">
                  \${col.label} <span class="count">\${colTasks.length}</span>
                </div>
                <div style="padding:0.4rem;flex:1;overflow-y:auto">
                  \${colTasks.length === 0
                    ? html\`<div class="empty">-</div>\`
                    : colTasks.map(t => html\`<div key=\${t.id}><\${MissionTaskCard} task=\${t} onUpdate=\${onUpdate} /></div>\`)}
                </div>
              </div>\`;
            })}
          </div>\`}
    </div>\`}
  </div>\`;
}

function MissionTaskCard({ task, onUpdate }) {
  const oodaColors = { observing: '#4caf50', orienting: '#4caf50', deciding: '#ffc107', waiting_human: '#ed6c6c', acting: '#00bcd4', done: '#666', failed: '#d46c6c' };
  const runningSpawns = (task.spawns || []).filter(s => s.status === 'running');
  const recentSpawns = (task.spawns || []).filter(s => s.status !== 'running').slice(-2).reverse();
  return html\`<div>
    <\${TaskCard} task=\${task} onUpdate=\${onUpdate} />
    \${runningSpawns.length > 0 && html\`<div style="margin:-0.25rem 0 0.5rem 0.5rem;padding:0.4rem 0.6rem;background:#0e1a0e;border:1px solid #1a2e1a;border-radius:6px;font-size:0.7rem">
      \${runningSpawns.map(s => html\`<div key=\${s.id} style="display:flex;align-items:center;gap:0.5rem;color:#6aed6c">
        <span style="animation:pulse 2s infinite">●</span>
        <span>@\${s.owner}</span>
        <span style="color:#666">PID \${s.pid}</span>
        <span style="color:#666">\${formatDuration(Date.now() - new Date(s.startedAt).getTime())}...</span>
      </div>\`)}
    </div>\`}
    \${recentSpawns.length > 0 && runningSpawns.length === 0 && html\`<div style="margin:-0.25rem 0 0.5rem 0.5rem;padding:0.4rem 0.6rem;background:#161616;border:1px solid #2a2a2a;border-radius:6px;font-size:0.7rem">
      \${recentSpawns.map(s => html\`<div key=\${s.id} style="display:flex;align-items:center;gap:0.5rem;color:\${s.status === 'done' ? '#666' : '#d46c6c'}">
        <span>\${s.status === 'done' ? '✓' : '✗'}</span>
        <span>@\${s.owner}</span>
        <span style="color:#555">\${s.finishedAt ? formatDuration(new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) : ''}</span>
        \${s.exitCode !== undefined && s.exitCode !== 0 && html\`<span style="color:#d46c6c">exit \${s.exitCode}</span>\`}
      </div>\`)}
    </div>\`}
  </div>\`;
}

function ActivityDashboard({ runners, spawns }) {
  const runningSpawns = spawns.filter(s => s.status === 'running');
  const recentSpawns = spawns.filter(s => s.status !== 'running');
  if (!runners.length && !runningSpawns.length && !recentSpawns.length) return null;

  const runnerStatusStyle = (status) => {
    if (status === 'running') return 'background:#1a2e2e;color:#6cced4';
    if (status === 'idle') return 'background:#2e2e1a;color:#edd76c';
    return 'background:#2e1a1a;color:#d46c6c';
  };

  return html\`<div style="margin-bottom:1rem">
    <h2 style="margin-top:0">Activity</h2>
    \${runners.length > 0 && html\`<div style="margin-bottom:0.75rem">
      <div style="font-size:0.75rem;color:#888;margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">Mission Runners</div>
      \${runners.map(r => {
        const elapsed = formatDuration(Date.now() - new Date(r.startedAt).getTime());
        const heartbeatAge = Math.floor((Date.now() - new Date(r.lastHeartbeat).getTime()) / 1000);
        const stale = heartbeatAge > 120;
        return html\`<div key=\${r.id} class="spawn" style=\${stale ? 'opacity:0.5' : ''}>
          <span class="spawn-status" style=\${runnerStatusStyle(r.status)}>\${r.status}</span>
          <span class="spawn-task">\${r.missionName}</span>
          \${r.currentTaskTitle && html\`<span style="font-size:0.7rem;color:#aaa;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title=\${r.currentTaskTitle}>→ \${r.currentTaskTitle}</span>\`}
          <span style="font-size:0.7rem;color:#888;font-family:monospace">PID \${r.pid}</span>
          <span style="font-size:0.7rem;color:#6aed6c">\${r.tasksProcessed} done</span>
          <span class="spawn-duration">\${elapsed}</span>
          \${stale && html\`<span style="font-size:0.65rem;color:#d46c6c" title="No heartbeat for \${heartbeatAge}s">stale</span>\`}
        </div>\`;
      })}
    </div>\`}
    \${runningSpawns.length > 0 && html\`<div style="margin-bottom:0.5rem">
      <div style="font-size:0.75rem;color:#888;margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">Active Spawns</div>
      \${runningSpawns.map(s => html\`<\${SpawnRow} key=\${s.id} s=\${s} />\`)}
    </div>\`}
    \${recentSpawns.length > 0 && html\`<div>
      <div style="font-size:0.75rem;color:#888;margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">Recent</div>
      \${recentSpawns.map(s => html\`<\${SpawnRow} key=\${s.id} s=\${s} />\`)}
    </div>\`}
  </div>\`;
}

function Board({ tasks, onUpdate }) {
  const [showAllDone, setShowAllDone] = useState(false);
  const [doneSortDesc, setDoneSortDesc] = useState(true);
  const DONE_LIMIT = 5;
  const cleanDone = async () => {
    await api.post('/api/clean', {});
    onUpdate();
  };
  return html\`<div class="board">
    \${COLUMNS.map(col => {
      const colTasks = tasks.filter(t => col.statuses.includes(t.status));
      const isDone = col.key === 'done';
      if (isDone) colTasks.sort((a, b) => {
        const ta = new Date(a.updatedAt || 0).getTime();
        const tb = new Date(b.updatedAt || 0).getTime();
        return doneSortDesc ? tb - ta : ta - tb;
      });
      const truncated = isDone && !showAllDone && colTasks.length > DONE_LIMIT;
      const visibleTasks = truncated ? colTasks.slice(0, DONE_LIMIT) : colTasks;
      return html\`<div class="column col-\${col.key}" key=\${col.key}>
        <div class="column-header">\${col.label} <span style="display:inline-flex;align-items:center;gap:0.35rem"><span class="count">\${colTasks.length}</span>\${isDone && colTasks.length > 0 && html\`<button style="font-size:0.6rem;padding:0.1rem 0.35rem;background:#1a1a1a;border:1px solid #333;border-radius:3px;color:#888;cursor:pointer" onClick=\${() => setDoneSortDesc(!doneSortDesc)}>\${doneSortDesc ? '↓' : '↑'}</button><button style="font-size:0.6rem;padding:0.1rem 0.35rem;background:#1a1a1a;border:1px solid #333;border-radius:3px;color:#888;cursor:pointer" onClick=\${cleanDone}>Clean</button>\`}</span></div>
        <div class="column-body">
          \${colTasks.length === 0
            ? html\`<div class="empty">-</div>\`
            : visibleTasks.map(t => html\`<\${TaskCard} key=\${t.id} task=\${t} onUpdate=\${onUpdate} />\`)}
          \${isDone && colTasks.length > DONE_LIMIT && html\`<button class="toggle-done" style="width:100%;margin-top:0.5rem;font-size:0.75rem;padding:0.3rem;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;color:#888;cursor:pointer"
            onClick=\${() => setShowAllDone(!showAllDone)}>\${showAllDone ? 'Show recent' : 'Show all (' + colTasks.length + ')'}</button>\`}
        </div>
      </div>\`;
    })}
  </div>\`;
}

function EditableFeedbackMessage({ fb, onSend }) {
  const saveFeedback = async (newMessage) => {
    await api.patch('/api/feedback/' + fb.id.slice(0, 8), { message: newMessage });
    onSend();
  };
  return html\`<\${EditableText} value=\${fb.message} onSave=\${saveFeedback} className="task-title" />\`;
}

function FeedbackSection({ projectFeedback, onSend }) {
  const allFeedback = (projectFeedback || []).filter(fb => fb.status === 'new');

  return html\`<div style="margin-bottom:1rem">
    <h2 style="margin-top:0">Feedback</h2>
    \${allFeedback.length > 0
      ? allFeedback.map(fb => html\`<div class="task" key=\${fb.id} style="border-left:3px solid #ed6c6c;display:flex;align-items:start;gap:0.5rem">
          <div style="flex:1">
            <\${EditableFeedbackMessage} fb=\${fb} onSend=\${onSend} />
            <div class="task-meta">from \${fb.from} · \${fb.projectName} · \${timeAgo(fb.createdAt)}</div>
          </div>
          <button class="danger" style="font-size:0.65rem;padding:0.15rem 0.3rem" onClick=\${async () => {
            await fetch('/api/feedback/' + fb.id.slice(0, 8), { method: 'DELETE' });
            onSend();
          }}>×</button>
        </div>\`)
      : html\`<div class="empty">No new feedback.</div>\`}
  </div>\`;
}

function ReportsSection({ reports, onUpdate }) {
  const visibleReports = reports.filter(r => r.status !== 'archived');
  if (!visibleReports.length) return null;
  const [expanded, setExpanded] = useState(null);
  const setStatus = async (id, status) => {
    await api.patch('/api/reports/' + id.slice(0, 8) + '/status', { status });
    onUpdate();
  };
  const statusColors = { unread: '#ed6c6c', reading: '#edd76c', read: '#666' };
  return html\`<div style="margin-bottom:1rem">
    <h2 style="margin-top:0">Reports \${visibleReports.filter(r => r.status === 'unread').length > 0 ? html\`<span style="color:#ed6c6c;font-size:0.75rem">(\${visibleReports.filter(r => r.status === 'unread').length} unread)</span>\` : null}</h2>
    \${visibleReports.map(r => html\`<div class="task" key=\${r.id} style="border-left:3px solid \${statusColors[r.status]}">
      <div class="task-title" style="cursor:pointer" onClick=\${() => { setExpanded(expanded === r.id ? null : r.id); if (r.status === 'unread') setStatus(r.id, 'reading'); }}>
        \${r.title}
        <span class="badge" style="background:\${statusColors[r.status]}20;color:\${statusColors[r.status]}">\${r.status}</span>
      </div>
      <div class="task-meta">by \${r.createdBy} · \${timeAgo(r.createdAt)}</div>
      \${expanded === r.id && html\`<div class="report-content" style="margin-top:0.5rem;font-size:0.85rem;line-height:1.5;color:#ccc" dangerouslySetInnerHTML=\${{ __html: marked.parse(r.content || '') }}></div>
        <div class="task-actions" style="margin-top:0.5rem">
          \${r.status !== 'read' && html\`<button onClick=\${() => setStatus(r.id, 'read')}>Mark read</button>\`}
          \${r.status === 'read' && html\`<button onClick=\${() => setStatus(r.id, 'unread')}>Mark unread</button>\`}
          \${r.status === 'read' && html\`<button onClick=\${() => setStatus(r.id, 'archived')}>Archive</button>\`}
        </div>\`}
    </div>\`)}
  </div>\`;
}

function App() {
  const [data, setData] = useState({ tasks: [], history: [], principles: [], heartbeat: null, spawns: [], projects: [], projectFeedback: [], reports: [], sleep: null, missions: [], runners: [] });
  const [tab, setTab] = useState('active');

  const refresh = useCallback(async () => {
    const [tasks, history, principles, heartbeat, spawns, projects, projectFeedback, reports, sleep, missions, runners] = await Promise.all([
      api.get('/api/tasks'), api.get('/api/history'), api.get('/api/principles'),
      api.get('/api/heartbeat'), api.get('/api/spawns'), api.get('/api/projects'), api.get('/api/projects/feedback'), api.get('/api/reports?category=human'),
      api.get('/api/sleep'), api.get('/api/missions'), api.get('/api/mission-runners'),
    ]);
    setData({ tasks, history, principles, heartbeat, spawns, projects, projectFeedback, reports, sleep, missions, runners });
  }, []);

  useEffect(() => { refresh(); const id = setInterval(refresh, 3000); return () => clearInterval(id); }, [refresh]);

  const missionTaskIds = new Set(data.missions.flatMap(m => (m.tasks || []).map(t => t.id)));

  return html\`
    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">
      <h1 style="margin:0">worqload</h1>
      <\${Heartbeat} heartbeat=\${data.heartbeat} sleepState=\${data.sleep} onUpdate=\${refresh} />
    </div>
    <\${Principles} items=\${data.principles} />
    \${data.reports.length > 0 && html\`<\${ReportsSection} reports=\${data.reports} onUpdate=\${refresh} />\`}
    \${data.projectFeedback.length > 0 && html\`<\${FeedbackSection} projectFeedback=\${data.projectFeedback} onSend=\${refresh} />\`}
    <\${FeedbackForm} onSend=\${refresh} />
    \${data.missions.length > 0 && html\`<\${MissionSection} missions=\${data.missions} onUpdate=\${refresh} />\`}
    <div class="tabs">
      <div class=\${"tab" + (tab === 'active' ? ' active' : '')} onClick=\${() => setTab('active')}>Active</div>
      <div class=\${"tab" + (tab === 'history' ? ' active' : '')} onClick=\${() => setTab('history')}>History</div>
    </div>
    \${tab === 'active' && html\`<\${Board} tasks=\${data.tasks.filter(t => !missionTaskIds.has(t.id))} onUpdate=\${refresh} />\`}
    \${tab === 'history' && html\`<\${HistoryView} history=\${data.history} />\`}
    <\${ActivityDashboard} runners=\${data.runners} spawns=\${data.spawns} />
  \`;
}

render(html\`<\${App} />\`, document.body);
</script>
</head>
<body></body>
</html>`;
}
