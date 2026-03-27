import { TaskQueue } from "./queue";
import { createTask } from "./task";
import { loadPrinciples } from "./principles";

export function startServer(port = 3456): void {
  const queue = new TaskQueue();

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/") {
        return new Response(html(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (req.method === "GET" && url.pathname === "/api/tasks") {
        await queue.load();
        return json(queue.list());
      }

      if (req.method === "GET" && url.pathname === "/api/history") {
        const history = await queue.history();
        return json(history);
      }

      if (req.method === "GET" && url.pathname === "/api/principles") {
        const content = await loadPrinciples();
        const lines = content.split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2));
        return json(lines);
      }

      if (req.method === "POST" && url.pathname === "/api/tasks") {
        await queue.load();
        const body = await req.json() as { title: string; priority?: number };
        const task = createTask(body.title, {}, body.priority ?? 0);
        queue.enqueue(task);
        await queue.save();
        return json(task, 201);
      }

      const decideMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/decide$/);
      if (req.method === "POST" && decideMatch) {
        await queue.load();
        const task = queue.findById(decideMatch[1]);
        if (!task) return json({ error: "Task not found" }, 404);
        if (task.status !== "waiting_human") return json({ error: "Task is not waiting for human" }, 400);
        const body = await req.json() as { decision: string };
        queue.transition(task.id, "deciding");
        queue.addLog(task.id, "decide", body.decision);
        await queue.save();
        return json(queue.get(task.id));
      }

      const patchMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (req.method === "PATCH" && patchMatch) {
        await queue.load();
        const task = queue.findById(patchMatch[1]);
        if (!task) return json({ error: "Task not found" }, 404);
        const body = await req.json() as { priority?: number };
        if (body.priority !== undefined) {
          queue.update(task.id, { priority: body.priority });
          await queue.save();
        }
        return json(queue.get(task.id));
      }

      const failMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/fail$/);
      if (req.method === "POST" && failMatch) {
        await queue.load();
        const task = queue.findById(failMatch[1]);
        if (!task) return json({ error: "Task not found" }, 404);
        const body = await req.json() as { reason?: string };
        queue.addLog(task.id, "act", `[FAILED] ${body.reason || "No reason given"}`);
        queue.transition(task.id, "failed");
        await queue.save();
        return json(queue.get(task.id));
      }

      const retryMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/);
      if (req.method === "POST" && retryMatch) {
        await queue.load();
        const task = queue.findById(retryMatch[1]);
        if (!task) return json({ error: "Task not found" }, 404);
        if (task.status !== "failed") return json({ error: "Task is not failed" }, 400);
        queue.addLog(task.id, "act", "[RETRY]");
        queue.transition(task.id, "pending");
        await queue.save();
        return json(queue.get(task.id));
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`worqload UI: http://localhost:${port}`);
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
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 2rem; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; color: #fff; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 0.75rem; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }

  .task { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1rem; margin-bottom: 0.5rem; }
  .task-header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
  .task-title { font-weight: 600; flex: 1; }
  .task-meta { font-size: 0.75rem; color: #666; white-space: nowrap; }

  .status { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
  .status-pending { background: #1a1a2e; color: #6c7aed; }
  .status-observing, .status-orienting { background: #1a2e1a; color: #6aed6c; }
  .status-deciding { background: #2e2a1a; color: #edd76c; }
  .status-waiting_human { background: #3d1a1a; color: #ed6c6c; animation: pulse 2s infinite; }
  .status-acting { background: #1a2e2e; color: #6cced4; }
  .status-done { background: #1a1a1a; color: #666; }
  .status-failed { background: #2e1a1a; color: #d46c6c; }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

  .human-action { margin-top: 0.75rem; display: flex; gap: 0.5rem; }
  .human-action input { flex: 1; background: #0a0a0a; border: 1px solid #333; border-radius: 4px; padding: 0.5rem; color: #e0e0e0; font-size: 0.9rem; }
  .human-action input:focus { outline: none; border-color: #ed6c6c; }

  .logs { margin-top: 0.5rem; }
  .log { font-size: 0.8rem; color: #888; padding: 0.2rem 0; font-family: monospace; }
  .log-phase { color: #6c7aed; }

  button { background: #2a2a2a; color: #e0e0e0; border: 1px solid #333; border-radius: 4px; padding: 0.5rem 1rem; cursor: pointer; font-size: 0.85rem; }
  button:hover { background: #333; }
  button.primary { background: #6c7aed; color: #fff; border-color: #6c7aed; }
  button.primary:hover { background: #5a68d4; }

  .add-form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
  .add-form input[type="text"] { flex: 1; background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.75rem; color: #e0e0e0; font-size: 0.95rem; }
  .add-form input[type="text"]:focus { outline: none; border-color: #6c7aed; }
  .add-form input[type="number"] { width: 5rem; background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.75rem; color: #e0e0e0; font-size: 0.95rem; text-align: center; }
  .add-form input[type="number"]:focus { outline: none; border-color: #6c7aed; }

  .principles { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; }
  .principles li { margin: 0.3rem 0; padding-left: 0.5rem; }

  .section-empty { color: #444; font-style: italic; padding: 0.5rem 0; }

  .tabs { display: flex; gap: 0.25rem; margin-bottom: 1rem; }
  .tab { padding: 0.4rem 1rem; border-radius: 4px 4px 0 0; cursor: pointer; font-size: 0.85rem; background: #161616; border: 1px solid #2a2a2a; border-bottom: none; color: #888; }
  .tab.active { background: #0a0a0a; color: #fff; border-color: #333; }

  .task-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; align-items: center; }
  .task-actions button { font-size: 0.75rem; padding: 0.25rem 0.5rem; }
  .task-actions button.danger { background: #2e1a1a; color: #d46c6c; border-color: #4a2a2a; }
  .task-actions button.danger:hover { background: #3d1a1a; }
  .task-actions button.retry { background: #1a2e1a; color: #6aed6c; border-color: #2a4a2a; }
  .task-actions button.retry:hover { background: #1a3d1a; }
  .priority-edit { width: 3.5rem; background: #0a0a0a; border: 1px solid #333; border-radius: 4px; padding: 0.2rem 0.4rem; color: #e0e0e0; font-size: 0.75rem; text-align: center; }
  .priority-edit:focus { outline: none; border-color: #6c7aed; }
  .action-label { font-size: 0.75rem; color: #888; }
</style>
</head>
<body>
  <h1>worqload</h1>

  <div class="principles" id="principles"></div>

  <div class="add-form">
    <input type="text" id="new-title" placeholder="New task title...">
    <input type="number" id="new-priority" value="0" placeholder="Priority" title="Priority (higher = more urgent)">
    <button class="primary" onclick="addTask()" title="Shift+Enter">Add</button>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('active')">Active</div>
    <div class="tab" onclick="switchTab('history')">History</div>
  </div>

  <div id="active-tasks"></div>
  <div id="history-tasks" style="display:none"></div>

  <script>
    let currentTab = 'active';

    async function load() {
      const focused = document.activeElement;
      const focusId = focused && focused.id ? focused.id : null;
      const focusValue = focused && focused.value !== undefined ? focused.value : null;
      const focusCursor = focused && focused.selectionStart !== undefined ? focused.selectionStart : null;

      const [tasks, history, principles] = await Promise.all([
        fetch('/api/tasks').then(r => r.json()),
        fetch('/api/history').then(r => r.json()),
        fetch('/api/principles').then(r => r.json()),
      ]);
      renderPrinciples(principles);
      renderTasks(tasks);
      renderHistory(history);

      if (focusId) {
        const el = document.getElementById(focusId);
        if (el) {
          el.focus();
          if (focusValue !== null) el.value = focusValue;
          if (focusCursor !== null) el.selectionStart = el.selectionEnd = focusCursor;
        }
      }
    }

    function renderPrinciples(items) {
      const el = document.getElementById('principles');
      if (items.length === 0) { el.innerHTML = '<div class="section-empty">No principles defined.</div>'; return; }
      el.innerHTML = '<h2 style="margin-top:0">Principles</h2><ol>' + items.map(p => '<li>' + esc(p) + '</li>').join('') + '</ol>';
    }

    function renderTasks(tasks) {
      const el = document.getElementById('active-tasks');
      const active = tasks.filter(t => t.status !== 'done' && t.status !== 'failed');
      const done = tasks.filter(t => t.status === 'done' || t.status === 'failed');
      if (active.length === 0 && done.length === 0) { el.innerHTML = '<div class="section-empty">No tasks.</div>'; return; }

      let h = '';
      if (active.length > 0) {
        h += active.map(renderTask).join('');
      }
      if (done.length > 0) {
        h += '<h2>Completed</h2>' + done.map(renderTask).join('');
      }
      el.innerHTML = h;
    }

    function renderHistory(tasks) {
      const el = document.getElementById('history-tasks');
      if (tasks.length === 0) { el.innerHTML = '<div class="section-empty">No archived tasks.</div>'; return; }
      el.innerHTML = tasks.slice().reverse().map(renderTask).join('');
    }

    function renderTask(t) {
      const logs = t.logs.length > 0
        ? '<div class="logs">' + t.logs.map(l => '<div class="log"><span class="log-phase">[' + esc(l.phase) + ']</span> ' + esc(l.content) + '</div>').join('') + '</div>'
        : '';
      const humanAction = t.status === 'waiting_human'
        ? '<div class="human-action"><input type="text" id="decide-' + t.id + '" placeholder="Your decision..." onkeydown="if(event.key===\\'Enter\\'&&event.shiftKey){event.preventDefault();decide(\\'' + t.id + '\\')}"><button class="primary" onclick="decide(\\'' + t.id + '\\')">Decide</button></div>'
        : '';
      const isTerminal = t.status === 'done' || t.status === 'failed';
      let actions = '';
      if (!isTerminal) {
        actions = '<div class="task-actions">'
          + '<label class="action-label">Priority</label><input type="number" class="priority-edit" value="' + t.priority + '" onchange="setPriority(\\'' + t.id + '\\', this.value)">'
          + '<button class="danger" onclick="failTask(\\'' + t.id + '\\')">Fail</button>'
          + '</div>';
      } else if (t.status === 'failed') {
        actions = '<div class="task-actions"><button class="retry" onclick="retryTask(\\'' + t.id + '\\')">Retry</button></div>';
      }
      const age = timeAgo(t.createdAt);
      return '<div class="task" title="' + t.id.slice(0, 8) + '"><div class="task-header"><span class="task-title">' + esc(t.title) + '</span><span class="status status-' + t.status + '">' + t.status + '</span><span class="task-meta">' + age + '</span></div>' + logs + humanAction + actions + '</div>';
    }

    async function addTask() {
      const titleEl = document.getElementById('new-title');
      const priorityEl = document.getElementById('new-priority');
      const title = titleEl.value.trim();
      if (!title) return;
      await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, priority: Number(priorityEl.value) || 0 }) });
      titleEl.value = '';
      priorityEl.value = '0';
      load();
    }

    async function decide(id) {
      const input = document.getElementById('decide-' + id);
      const decision = input.value.trim();
      if (!decision) return;
      await fetch('/api/tasks/' + id.slice(0, 8) + '/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
      load();
    }

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelector('.tab:' + (tab === 'active' ? 'first-child' : 'last-child')).classList.add('active');
      document.getElementById('active-tasks').style.display = tab === 'active' ? '' : 'none';
      document.getElementById('history-tasks').style.display = tab === 'history' ? '' : 'none';
    }

    async function setPriority(id, value) {
      await fetch('/api/tasks/' + id.slice(0, 8), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priority: Number(value) || 0 }) });
      load();
    }

    async function failTask(id) {
      const reason = prompt('Fail reason:');
      if (reason === null) return;
      await fetch('/api/tasks/' + id.slice(0, 8) + '/fail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
      load();
    }

    async function retryTask(id) {
      await fetch('/api/tasks/' + id.slice(0, 8) + '/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      load();
    }

    function timeAgo(iso) {
      const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (seconds < 60) return seconds + 's ago';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      const days = Math.floor(hours / 24);
      return days + 'd ago';
    }

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    document.getElementById('new-title').addEventListener('keydown', e => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); addTask(); } });

    load();
    setInterval(load, 3000);
  </script>
</body>
</html>`;
}
