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
  h2 { font-size: 1rem; margin: 1rem 0 0.5rem; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }

  .task { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.75rem; margin-bottom: 0.5rem; }
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
  .add-form input[type="number"] { width: 4.5rem; background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.6rem; color: #e0e0e0; font-size: 0.9rem; text-align: center; }
  .add-form input[type="number"]:focus { outline: none; border-color: #6c7aed; }

  .principles { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 0.75rem; margin-bottom: 1rem; }
  .principles li { margin: 0.2rem 0; padding-left: 0.5rem; font-size: 0.85rem; }

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
<script type="module">
import { h, render } from 'https://esm.sh/preact@10.25.4';
import { useState, useEffect, useRef, useCallback } from 'https://esm.sh/preact@10.25.4/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
const html = htm.bind(h);

const COLUMNS = [
  { key: 'pending', label: 'Pending', statuses: ['pending'] },
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

function Heartbeat({ heartbeat }) {
  if (!heartbeat) return null;
  const elapsed = Math.floor((Date.now() - new Date(heartbeat.lastRun).getTime()) / 1000);
  const remaining = Math.max(0, heartbeat.intervalSeconds - elapsed);
  const text = remaining === 0 ? 'Loop: running...' : 'Next loop: ' + (remaining >= 60 ? Math.floor(remaining / 60) + 'm ' : '') + (remaining % 60) + 's';
  const color = remaining === 0 ? '#6cced4' : '#888';
  return html\`<span style="font-size:0.85rem;color:\${color}">\${text}</span>\`;
}

function Principles({ items }) {
  if (!items.length) return html\`<div class="principles"><div class="empty">No principles defined.</div></div>\`;
  return html\`<div class="principles"><h2 style="margin-top:0">Principles</h2><ol>\${items.map(p => html\`<li key=\${p}>\${p}</li>\`)}</ol></div>\`;
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
  return html\`<div class="spawn">
    <span class="spawn-status spawn-\${s.status}">\${s.status}</span>
    <span class="spawn-task">\${s.taskTitle}</span>
    <span class="spawn-owner">@\${s.owner}</span>
    <span class="spawn-pid">PID \${s.pid}</span>
    <span class="spawn-duration">\${dur}</span>
  </div>\`;
}

function AddForm({ onAdd }) {
  const titleRef = useRef(null);
  const prioRef = useRef(null);
  const submit = async () => {
    const title = titleRef.current.value.trim();
    if (!title) return;
    await api.post('/api/tasks', { title, priority: Number(prioRef.current.value) || 0 });
    titleRef.current.value = '';
    prioRef.current.value = '0';
    onAdd();
  };
  const onKey = (e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); submit(); } };
  return html\`<div class="add-form">
    <input type="text" ref=\${titleRef} placeholder="New task title..." onKeyDown=\${onKey} />
    <input type="number" ref=\${prioRef} defaultValue="0" placeholder="Pri" title="Priority (higher = more urgent)" />
    <button class="primary" onClick=\${submit} title="Shift+Enter">Add</button>
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

  return html\`<div class="task" title=\${task.id.slice(0, 8)}>
    <div class="task-title">
      \${task.title}
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
        onKeyDown=\${(e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); submitDecide(); }}} />
      <button class="primary" onClick=\${submitDecide}>Answer</button>
    </div>\`}
    \${task.logs.length > 0 && html\`<div class="logs">
      \${task.logs.map((l, i) => html\`<div class="log" key=\${i}><span class="log-phase">[\${l.phase}]</span> \${l.content}</div>\`)}
    </div>\`}
    \${!isTerminal && html\`<div class="task-actions">
      <label class="action-label">Pri</label>
      <input type="number" class="priority-edit" defaultValue=\${task.priority} key=\${task.id + '-p-' + task.priority} onChange=\${setPriority} />
      <button class="danger" onClick=\${failTask}>Fail</button>
    </div>\`}
    \${task.status === 'failed' && html\`<div class="task-actions">
      <button class="retry" onClick=\${retryTask}>Retry</button>
    </div>\`}
  </div>\`;
}

function Board({ tasks, onUpdate }) {
  return html\`<div class="board">
    \${COLUMNS.map(col => {
      const colTasks = tasks.filter(t => col.statuses.includes(t.status));
      return html\`<div class="column col-\${col.key}" key=\${col.key}>
        <div class="column-header">\${col.label} <span class="count">\${colTasks.length}</span></div>
        <div class="column-body">
          \${colTasks.length === 0
            ? html\`<div class="empty">-</div>\`
            : colTasks.map(t => html\`<\${TaskCard} key=\${t.id} task=\${t} onUpdate=\${onUpdate} />\`)}
        </div>
      </div>\`;
    })}
  </div>\`;
}

function App() {
  const [data, setData] = useState({ tasks: [], history: [], principles: [], heartbeat: null, spawns: [] });
  const [tab, setTab] = useState('active');

  const refresh = useCallback(async () => {
    const [tasks, history, principles, heartbeat, spawns] = await Promise.all([
      api.get('/api/tasks'), api.get('/api/history'), api.get('/api/principles'),
      api.get('/api/heartbeat'), api.get('/api/spawns'),
    ]);
    setData({ tasks, history, principles, heartbeat, spawns });
  }, []);

  useEffect(() => { refresh(); const id = setInterval(refresh, 3000); return () => clearInterval(id); }, [refresh]);

  return html\`
    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">
      <h1 style="margin:0">worqload</h1>
      <\${Heartbeat} heartbeat=\${data.heartbeat} />
    </div>
    <\${Principles} items=\${data.principles} />
    <\${SpawnList} spawns=\${data.spawns} />
    <\${AddForm} onAdd=\${refresh} />
    <div class="tabs">
      <div class=\${"tab" + (tab === 'active' ? ' active' : '')} onClick=\${() => setTab('active')}>Active</div>
      <div class=\${"tab" + (tab === 'history' ? ' active' : '')} onClick=\${() => setTab('history')}>History</div>
    </div>
    \${tab === 'active' && html\`<\${Board} tasks=\${data.tasks} onUpdate=\${refresh} />\`}
    \${tab === 'history' && html\`<div class="board"><div class="column" style="flex:1;min-width:auto">
      <div class="column-header">Archived <span class="count">\${data.history.length}</span></div>
      <div class="column-body">
        \${data.history.length === 0
          ? html\`<div class="empty">No archived tasks.</div>\`
          : data.history.slice().reverse().map(t => html\`<\${TaskCard} key=\${t.id} task=\${t} onUpdate=\${refresh} />\`)}
      </div>
    </div></div>\`}
  \`;
}

render(html\`<\${App} />\`, document.body);
</script>
</head>
<body></body>
</html>`;
}
