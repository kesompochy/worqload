<script>
  let sessions = $state([]);
  let selectedSessionId = $state(null);
  let reports = $state([]);
  let feedback = $state([]);
  let loading = $state(true);
  let searchQuery = $state("");
  let searchResults = $state(null);
  let searching = $state(false);
  let searchTimer = null;

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
    searchResults = null;
    searchQuery = "";
    selectedSessionId = sessionId;
    const [rRes, fRes] = await Promise.all([
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/reports`),
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/feedback`),
    ]);
    reports = (await rRes.json()).reports;
    feedback = (await fRes.json()).feedback;
  }

  async function doSearch(q) {
    if (!q.trim()) {
      searchResults = null;
      return;
    }
    searching = true;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
      const data = await res.json();
      searchResults = data;
    } catch {
      searchResults = { reports: [], feedback: [] };
    }
    searching = false;
  }

  function onSearchInput(e) {
    const q = e.target.value;
    searchQuery = q;
    if (searchTimer) clearTimeout(searchTimer);
    if (!q.trim()) {
      searchResults = null;
      return;
    }
    searchTimer = setTimeout(() => doSearch(q), 300);
  }

  function clearSearch() {
    searchQuery = "";
    searchResults = null;
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

  let searchTimeline = $derived(
    searchResults
      ? [...searchResults.reports.map(r => ({ ...r, kind: "report" })), ...searchResults.feedback.map(f => ({ ...f, kind: "feedback" }))]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : []
  );

  $effect(() => { fetchSessions(); });
</script>

<div class="archive-layout">
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="app-name">worqload</div>
      <h1>archive</h1>
      <div class="search-box">
        <input
          type="text"
          placeholder="検索…"
          value={searchQuery}
          oninput={onSearchInput}
          class="search-input"
        />
        {#if searchQuery}
          <button class="search-clear" onclick={clearSearch}>&times;</button>
        {/if}
      </div>
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
            {#if s.initialPrompt}
              <div class="session-prompt">{s.initialPrompt.slice(0, 80)}</div>
            {/if}
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
    {#if searchResults}
      {#if searching}
        <div class="empty-detail">検索中…</div>
      {:else if searchTimeline.length === 0}
        <div class="empty-detail">「{searchQuery}」に一致する結果なし</div>
      {:else}
        <div class="search-result-count">{searchTimeline.length}件の結果</div>
        <div class="timeline">
          {#each searchTimeline as item}
            <div class="timeline-item" class:is-feedback={item.kind === "feedback"}>
              <div class="timeline-header">
                <span class="timeline-kind">{item.kind === "report" ? "Report" : "Feedback"}</span>
                {#if item.slug}<span class="timeline-slug">{item.slug}</span>{/if}
                <button class="timeline-session" onclick={() => selectSession(item.sessionId)}>
                  {item.sessionId.slice(0, 8)}
                </button>
                <span class="timeline-time">{formatTime(item.createdAt)}</span>
                <span class="timeline-file">{item.filename}</span>
              </div>
              <pre class="timeline-body">{item.body}</pre>
            </div>
          {/each}
        </div>
      {/if}
    {:else if !selectedSessionId}
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
  .session-prompt {
    font-size: 12px;
    color: var(--text-secondary, #aaa);
    margin-top: .15rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
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
  .search-box {
    position: relative;
    margin-top: .5rem;
  }
  .search-input {
    width: 100%;
    padding: .4rem .6rem;
    padding-right: 1.8rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 13px;
    outline: none;
  }
  .search-input:focus { border-color: var(--accent); }
  .search-clear {
    position: absolute;
    right: 2px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    padding: .15rem .4rem;
    font-size: 16px;
    color: var(--text-dim);
    cursor: pointer;
    line-height: 1;
  }
  .search-clear:hover { color: var(--text); background: none; }
  .search-result-count {
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: .5rem;
  }
  .timeline-session {
    font-size: 11px;
    padding: .1rem .4rem;
    border-radius: 3px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
</style>
