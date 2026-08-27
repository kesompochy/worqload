<script>
  let sessions = $state([]);
  let selectedSessionId = $state(null);
  let reports = $state([]);
  let feedback = $state([]);
  let loading = $state(true);

  async function fetchSessions() {
    loading = true;
    try {
      const res = await fetch("/api/sessions");
      const data = await res.json();
      sessions = data.sessions;
    } catch {
      sessions = [];
    }
    loading = false;
  }

  async function selectSession(sessionId) {
    selectedSessionId = sessionId;
    const [rRes, fRes] = await Promise.all([
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/reports`),
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/feedback`),
    ]);
    reports = (await rRes.json()).reports;
    feedback = (await fRes.json()).feedback;
  }

  function formatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function repoShort(repo) {
    const parts = repo.split("/");
    return parts.length >= 2 ? parts.slice(-2).join("/") : repo;
  }

  let timeline = $derived(
    [...reports.map(r => ({ ...r, kind: "report" })), ...feedback.map(f => ({ ...f, kind: "feedback" }))]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  );

  $effect(() => { fetchSessions(); });
</script>

<div class="archive-layout">
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="app-name">worqload</div>
      <h1>archive</h1>
    </div>
    <div class="session-list">
      {#if loading}
        <div class="empty">読み込み中…</div>
      {:else if sessions.length === 0}
        <div class="empty">アーカイブなし</div>
      {:else}
        {#each sessions as s}
          <button
            class="session-card"
            class:active={selectedSessionId === s.sessionId}
            onclick={() => selectSession(s.sessionId)}
          >
            <div class="session-id">{s.sessionId.slice(0, 8)}</div>
            <div class="session-meta">
              <span class="repo">{repoShort(s.repo)}</span>
              <span class="counts">{s.reportCount}R / {s.feedbackCount}F</span>
            </div>
            <div class="session-time">{formatTime(s.latestAt)}</div>
          </button>
        {/each}
      {/if}
    </div>
  </aside>
  <main class="detail">
    {#if !selectedSessionId}
      <div class="empty-detail">セッションを選択してください</div>
    {:else if timeline.length === 0}
      <div class="empty-detail">データなし</div>
    {:else}
      <div class="timeline">
        {#each timeline as item}
          <div class="timeline-item" class:is-feedback={item.kind === "feedback"}>
            <div class="timeline-header">
              <span class="timeline-kind">{item.kind === "report" ? "Report" : "Feedback"}</span>
              {#if item.slug}<span class="timeline-slug">{item.slug}</span>{/if}
              <span class="timeline-time">{formatTime(item.createdAt)}</span>
              <span class="timeline-file">{item.filename}</span>
            </div>
            <pre class="timeline-body">{item.body}</pre>
          </div>
        {/each}
      </div>
    {/if}
  </main>
</div>

<style>
  .archive-layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    height: 100vh;
  }
  .sidebar {
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .sidebar-header {
    padding: .75rem;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-header .app-name {
    font-size: 11px;
    letter-spacing: .08em;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .sidebar-header h1 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .session-list {
    overflow-y: auto;
    flex: 1;
  }
  .session-card {
    display: block;
    width: 100%;
    text-align: left;
    padding: .65rem .75rem;
    border: 0;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: transparent;
    cursor: pointer;
  }
  .session-card:hover { background: var(--panel); }
  .session-card.active { background: var(--panel-2); border-left: 3px solid var(--accent); padding-left: calc(.75rem - 3px); }
  .session-id { font-weight: 600; font-size: 13px; }
  .session-meta { font-size: 12px; color: var(--text-dim); margin-top: .15rem; display: flex; gap: .6rem; }
  .session-time { font-size: 11px; color: var(--text-dim); margin-top: .1rem; }
  .empty { padding: 1.5rem; color: var(--text-dim); text-align: center; }
  .detail { overflow-y: auto; padding: 1rem 1.5rem; }
  .empty-detail { color: var(--text-dim); padding: 3rem; text-align: center; }
  .timeline { display: flex; flex-direction: column; gap: .75rem; }
  .timeline-item {
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .timeline-item.is-feedback {
    border-color: #3d4a3a;
  }
  .timeline-header {
    display: flex;
    align-items: center;
    gap: .5rem;
    padding: .45rem .75rem;
    background: var(--panel);
    font-size: 12px;
    border-bottom: 1px solid var(--border);
  }
  .timeline-kind {
    font-weight: 600;
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: .04em;
  }
  .is-feedback .timeline-kind { color: #3fb950; }
  .timeline-slug { color: var(--accent); }
  .timeline-time { color: var(--text-dim); margin-left: auto; }
  .timeline-file { color: var(--text-dim); }
  .timeline-body { padding: .75rem; line-height: 1.5; }
</style>
