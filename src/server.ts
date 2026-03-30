import { TaskQueue } from "./queue";
import { createTask } from "./task";
import { loadPrinciples } from "./principles";
import { loadSpawns } from "./spawns";

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

      if (req.method === "GET" && url.pathname === "/api/heartbeat") {
        const file = Bun.file(".worqload/heartbeat.json");
        if (!(await file.exists())) return json(null);
        return json(await file.json());
      }

      if (req.method === "GET" && url.pathname === "/api/principles") {
        const content = await loadPrinciples();
        const lines = content.split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2));
        return json(lines);
      }

      if (req.method === "GET" && url.pathname === "/api/spawns") {
        const spawns = await loadSpawns();
        return json(spawns);
      }

      if (req.method === "POST" && url.pathname === "/api/tasks") {
        await queue.load();
        const body = await req.json() as { title: string; priority?: number; createdBy?: string };
        const task = createTask(body.title, {}, body.priority ?? 0, body.createdBy);
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
  h2 { font-size: 1.1rem; margin: 1.5rem 0 0.75rem; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }

  .task { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.75rem; margin-bottom: 0.5rem; }
  .task-title { font-weight: 600; font-size: 0.85rem; word-break: break-word; }
  .task-meta { font-size: 0.7rem; color: #666; margin-top: 0.25rem; }
  .task-owner { font-size: 0.65rem; color: #6cced4; background: #1a2e2e; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .task-created-by { font-size: 0.65rem; color: #b0a0d0; margin-left: 0.3rem; }

  .status { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }
  .status-pending { background: #1a1a2e; color: #6c7aed; }
  .status-observing, .status-orienting { background: #1a2e1a; color: #6aed6c; }
  .status-deciding { background: #2e2a1a; color: #edd76c; }
  .status-waiting_human { background: #3d1a1a; color: #ed6c6c; animation: pulse 2s infinite; }
  .status-acting { background: #1a2e2e; color: #6cced4; }
  .status-done { background: #1a1a1a; color: #666; }
  .status-failed { background: #2e1a1a; color: #d46c6c; }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

  .human-action { margin-top: 0.5rem; display: flex; gap: 0.25rem; }
  .human-action input { flex: 1; background: #0a0a0a; border: 1px solid #333; border-radius: 4px; padding: 0.35rem; color: #e0e0e0; font-size: 0.8rem; min-width: 0; }
  .human-action input:focus { outline: none; border-color: #ed6c6c; }

  .logs { margin-top: 0.4rem; max-height: 6rem; overflow-y: auto; }
  .log { font-size: 0.7rem; color: #888; padding: 0.15rem 0; font-family: monospace; }
  .log-phase { color: #6c7aed; }

  button { background: #2a2a2a; color: #e0e0e0; border: 1px solid #333; border-radius: 4px; padding: 0.4rem 0.75rem; cursor: pointer; font-size: 0.8rem; }
  button:hover { background: #333; }
  button.primary { background: #6c7aed; color: #fff; border-color: #6c7aed; }
  button.primary:hover { background: #5a68d4; }

  .add-form { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .add-form input[type="text"] { flex: 1; background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.6rem; color: #e0e0e0; font-size: 0.9rem; }
  .add-form input[type="text"]:focus { outline: none; border-color: #6c7aed; }
  .add-form input[type="number"] { width: 4.5rem; background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.6rem; color: #e0e0e0; font-size: 0.9rem; text-align: center; }
  .add-form input[type="number"]:focus { outline: none; border-color: #6c7aed; }

  .principles { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.75rem; margin-bottom: 1rem; }
  .principles li { margin: 0.2rem 0; padding-left: 0.5rem; font-size: 0.85rem; }

  .section-empty { color: #444; font-style: italic; padding: 0.5rem 0; font-size: 0.8rem; }

  .tabs { display: flex; gap: 0.25rem; margin-bottom: 1rem; }
  .tab { padding: 0.4rem 1rem; border-radius: 4px 4px 0 0; cursor: pointer; font-size: 0.85rem; background: #161616; border: 1px solid #2a2a2a; border-bottom: none; color: #888; }
  .tab.active { background: #0a0a0a; color: #fff; border-color: #333; }

  .task-actions { display: flex; gap: 0.35rem; margin-top: 0.4rem; align-items: center; flex-wrap: wrap; }
  .task-actions button { font-size: 0.7rem; padding: 0.2rem 0.4rem; }
  .task-actions button.danger { background: #2e1a1a; color: #d46c6c; border-color: #4a2a2a; }
  .task-actions button.danger:hover { background: #3d1a1a; }
  .task-actions button.retry { background: #1a2e1a; color: #6aed6c; border-color: #2a4a2a; }
  .task-actions button.retry:hover { background: #1a3d1a; }
  .priority-edit { width: 3rem; background: #0a0a0a; border: 1px solid #333; border-radius: 4px; padding: 0.15rem 0.3rem; color: #e0e0e0; font-size: 0.7rem; text-align: center; }
  .priority-edit:focus { outline: none; border-color: #6c7aed; }
  .action-label { font-size: 0.7rem; color: #888; }

  .board { display: flex; gap: 0.75rem; overflow-x: auto; padding-bottom: 1rem; min-height: 300px; }
  .column { flex: 0 0 220px; min-width: 220px; background: #111; border: 1px solid #222; border-radius: 8px; display: flex; flex-direction: column; }
  .column-header { padding: 0.6rem 0.75rem; border-bottom: 1px solid #222; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; display: flex; justify-content: space-between; align-items: center; }
  .column-header .count { font-size: 0.7rem; font-weight: 400; color: #666; background: #1a1a1a; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .column-body { padding: 0.5rem; flex: 1; overflow-y: auto; }

  .col-pending .column-header { color: #6c7aed; border-bottom-color: #2a2a4a; }
  .col-observe .column-header { color: #6aed6c; border-bottom-color: #2a4a2a; }
  .col-orient .column-header { color: #6aed6c; border-bottom-color: #2a4a2a; }
  .col-decide .column-header { color: #edd76c; border-bottom-color: #4a4a2a; }
  .col-act .column-header { color: #6cced4; border-bottom-color: #2a4a4a; }
  .col-done .column-header { color: #666; border-bottom-color: #222; }

  .spawns { margin-bottom: 1rem; }
  .spawn { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.75rem; }
  .spawn-task { flex: 1; font-weight: 500; font-size: 0.9rem; }
  .spawn-owner { font-size: 0.7rem; color: #6cced4; background: #1a2e2e; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .spawn-pid { font-size: 0.7rem; color: #888; font-family: monospace; }
  .spawn-status { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
  .spawn-running { background: #1a2e2e; color: #6cced4; animation: pulse 2s infinite; }
  .spawn-done { background: #1a2e1a; color: #6aed6c; }
  .spawn-failed { background: #2e1a1a; color: #d46c6c; }
  .spawn-duration { font-size: 0.75rem; color: #666; white-space: nowrap; }
</style>
</head>
<body>
  <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">
    <h1 style="margin:0">worqload</h1>
    <span id="heartbeat" style="font-size:0.85rem;color:#666"></span>
  </div>

  <div class="principles" id="principles"></div>
  <div class="spawns" id="spawns"></div>

  <div class="add-form">
    <input type="text" id="new-title" placeholder="New task title...">
    <input type="number" id="new-priority" value="0" placeholder="Pri" title="Priority (higher = more urgent)">
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

    const COLUMNS = [
      { key: 'pending', label: 'Pending', statuses: ['pending'] },
      { key: 'observe', label: 'Observe', statuses: ['observing'] },
      { key: 'orient', label: 'Orient', statuses: ['orienting'] },
      { key: 'decide', label: 'Decide', statuses: ['deciding', 'waiting_human'] },
      { key: 'act', label: 'Act', statuses: ['acting'] },
      { key: 'done', label: 'Done', statuses: ['done', 'failed'] },
    ];

    async function load() {
      const focused = document.activeElement;
      const focusId = focused && focused.id ? focused.id : null;
      const focusValue = focused && focused.value !== undefined ? focused.value : null;
      const focusCursor = focused && focused.selectionStart !== undefined ? focused.selectionStart : null;

      const [tasks, history, principles, heartbeat, spawns] = await Promise.all([
        fetch('/api/tasks').then(r => r.json()),
        fetch('/api/history').then(r => r.json()),
        fetch('/api/principles').then(r => r.json()),
        fetch('/api/heartbeat').then(r => r.json()),
        fetch('/api/spawns').then(r => r.json()),
      ]);
      renderPrinciples(principles);
      renderSpawns(spawns);
      renderBoard(tasks);
      renderHistory(history);
      renderHeartbeat(heartbeat);

      if (focusId) {
        const el = document.getElementById(focusId);
        if (el) {
          el.focus();
          if (focusValue !== null) el.value = focusValue;
          if (focusCursor !== null) el.selectionStart = el.selectionEnd = focusCursor;
        }
      }
    }

    function renderHeartbeat(hb) {
      const el = document.getElementById('heartbeat');
      if (!hb) { el.textContent = ''; return; }
      const elapsed = Math.floor((Date.now() - new Date(hb.lastRun).getTime()) / 1000);
      const remaining = Math.max(0, hb.intervalSeconds - elapsed);
      if (remaining === 0) {
        el.textContent = 'Loop: running...';
        el.style.color = '#6cced4';
      } else {
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        el.textContent = 'Next loop: ' + (m > 0 ? m + 'm ' : '') + s + 's';
        el.style.color = '#888';
      }
    }

    function renderPrinciples(items) {
      const el = document.getElementById('principles');
      if (items.length === 0) { el.innerHTML = '<div class="section-empty">No principles defined.</div>'; return; }
      el.innerHTML = '<h2 style="margin-top:0">Principles</h2><ol>' + items.map(p => '<li>' + esc(p) + '</li>').join('') + '</ol>';
    }

    function renderSpawns(spawns) {
      const el = document.getElementById('spawns');
      const running = spawns.filter(s => s.status === 'running');
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      const recent = spawns.filter(s => s.status !== 'running' && s.finishedAt && new Date(s.finishedAt).getTime() > fiveMinAgo).slice(-10).reverse();
      if (running.length === 0 && recent.length === 0) { el.innerHTML = ''; return; }

      let h = '<h2 style="margin-top:0">Spawns</h2>';
      if (running.length > 0) {
        h += running.map(s => renderSpawn(s)).join('');
      }
      if (recent.length > 0) {
        h += '<div style="margin-top:0.5rem;font-size:0.75rem;color:#666">Recent</div>' + recent.map(s => renderSpawn(s)).join('');
      }
      el.innerHTML = h;
    }

    function renderSpawn(s) {
      let duration = '';
      if (s.finishedAt) {
        const ms = new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime();
        duration = formatDuration(ms);
      } else {
        const ms = Date.now() - new Date(s.startedAt).getTime();
        duration = formatDuration(ms) + '...';
      }
      return '<div class="spawn">'
        + '<span class="spawn-status spawn-' + s.status + '">' + s.status + '</span>'
        + '<span class="spawn-task">' + esc(s.taskTitle) + '</span>'
        + '<span class="spawn-owner">@' + esc(s.owner) + '</span>'
        + '<span class="spawn-pid">PID ' + s.pid + '</span>'
        + '<span class="spawn-duration">' + duration + '</span>'
        + '</div>';
    }

    function formatDuration(ms) {
      const totalSeconds = Math.floor(ms / 1000);
      if (totalSeconds < 60) return totalSeconds + 's';
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      if (minutes < 60) return minutes + 'm ' + seconds + 's';
      const hours = Math.floor(minutes / 60);
      return hours + 'h ' + (minutes % 60) + 'm';
    }

    function renderBoard(tasks) {
      const el = document.getElementById('active-tasks');
      let h = '<div class="board">';
      for (const col of COLUMNS) {
        const colTasks = tasks.filter(t => col.statuses.includes(t.status));
        h += '<div class="column col-' + col.key + '">';
        h += '<div class="column-header">' + col.label + '<span class="count">' + colTasks.length + '</span></div>';
        h += '<div class="column-body">';
        if (colTasks.length === 0) {
          h += '<div class="section-empty">-</div>';
        } else {
          h += colTasks.map(renderCard).join('');
        }
        h += '</div></div>';
      }
      h += '</div>';
      el.innerHTML = h;
    }

    function renderHistory(tasks) {
      const el = document.getElementById('history-tasks');
      if (tasks.length === 0) { el.innerHTML = '<div class="section-empty">No archived tasks.</div>'; return; }
      el.innerHTML = '<div class="board"><div class="column" style="flex:1;min-width:auto"><div class="column-header">Archived<span class="count">' + tasks.length + '</span></div><div class="column-body">' + tasks.slice().reverse().map(renderCard).join('') + '</div></div></div>';
    }

    function renderCard(t) {
      const logs = t.logs.length > 0
        ? '<div class="logs">' + t.logs.map(l => '<div class="log"><span class="log-phase">[' + esc(l.phase) + ']</span> ' + esc(l.content) + '</div>').join('') + '</div>'
        : '';
      const humanAction = t.status === 'waiting_human'
        ? '<div class="human-action"><input type="text" id="decide-' + t.id + '" placeholder="Decision..." onkeydown="if(event.key===\\'Enter\\'&&event.shiftKey){event.preventDefault();decide(\\'' + t.id + '\\')}"><button class="primary" onclick="decide(\\'' + t.id + '\\')">OK</button></div>'
        : '';
      const isTerminal = t.status === 'done' || t.status === 'failed';
      let actions = '';
      if (!isTerminal) {
        actions = '<div class="task-actions">'
          + '<label class="action-label">Pri</label><input type="number" class="priority-edit" value="' + t.priority + '" onchange="setPriority(\\'' + t.id + '\\', this.value)">'
          + '<button class="danger" onclick="failTask(\\'' + t.id + '\\')">Fail</button>'
          + '</div>';
      } else if (t.status === 'failed') {
        actions = '<div class="task-actions"><button class="retry" onclick="retryTask(\\'' + t.id + '\\')">Retry</button></div>';
      }
      const age = timeAgo(t.createdAt);
      const ownerBadge = t.owner ? ' <span class="task-owner">@' + esc(t.owner) + '</span>' : '';
      const createdByBadge = t.createdBy ? ' <span class="task-created-by">by ' + esc(t.createdBy) + '</span>' : '';
      const statusBadge = t.status === 'waiting_human' ? ' <span class="status status-waiting_human">waiting</span>' : (t.status === 'failed' ? ' <span class="status status-failed">failed</span>' : '');
      return '<div class="task" title="' + t.id.slice(0, 8) + '"><div class="task-title">' + esc(t.title) + statusBadge + ownerBadge + '</div><div class="task-meta">' + age + ' \\u00b7 p' + t.priority + createdByBadge + '</div>' + logs + humanAction + actions + '</div>';
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
