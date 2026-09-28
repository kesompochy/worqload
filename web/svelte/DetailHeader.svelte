<script>
  // The detail pane's top strip: title + status badge + action buttons, the
  // metadata line, and the tab bar — plus the inline action panel
  // (ActionBar.svelte), kept here directly under its buttons so it stays above
  // the tab bar rather than landing inside the active tab's region. Mounted into
  // #detailHeader from main.ts; renders nothing until a session with loaded
  // detail is selected. The scroll body (#detailBodyMount) is DetailBody.svelte
  // and the feedback/resume composer (#detailComposer) is Composer.svelte. The
  // Events tab's "· Ns ago" label reads the reactive `clock` so it counts up
  // between streamed events. Its count and age cover only agent-work events —
  // reports/feedback/escalations live in their own tabs (see events-view.js).
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState } from "../state.svelte.js";
  import { formatRelative, eventAgeIsStale, eventCountLevel, toast } from "../dom.js";
  import { isAgentWorkEvent } from "../events-view.js";
  import { clock } from "../clock.svelte.js";
  import { switchTab, onExpandAllDiffFiles, onCollapseAllDiffFiles, toggleActionPanel, runDirectAction, onToggleReviseMode, onSwitchModel, toggleEventsTab } from "../handlers.js";
  import { addLink, removeLink } from "../api.js";
  import ActionBar from "./ActionBar.svelte";

  const allTabs = [
    { id: "reports", label: "Reports" },
    { id: "feedback", label: "Feedbacks" },
    { id: "diff", label: "Diff" },
    { id: "files", label: "Files" },
    { id: "structure", label: "Structure" },
    { id: "events", label: "Events" },
  ];
  const tabs = $derived(appState.eventsTabHidden && appState.activeTab !== "events" ? allTabs.filter(t => t.id !== "events") : allTabs);

  function showEvents() {
    if (appState.eventsTabHidden) toggleEventsTab();
    switchTab("events");
  }

  // The selected session's outstanding work asking for the human's attention:
  // reports not yet marked read, plus escalations that pause the agent's turn
  // until answered. Surfaced as a single badge on the Reports tab so the human
  // notices unacked items even while viewing another tab (Diff / Events / ...).
  // The branch's remote PR URL once the lazy lookup resolves, else null. A
  // session whose branch already has a PR can't open another, so this both
  // gates the Create PR button and renders the link beside it.
  const prUrl = $derived(appState.prLink?.url ?? null);

  const unreadReportCount = $derived(appState.reports.filter(r => !r.read).length);
  const unresolvedEscalationCount = $derived(appState.asking.length);
  const reportsAttentionCount = $derived(unreadReportCount + unresolvedEscalationCount);
  const reportsAttentionTitle = $derived(`未読レポート ${unreadReportCount} + 未解決エスカレ ${unresolvedEscalationCount}`);

  // Visual IA: cluster the action buttons by `group`. A separator is rendered
  // whenever the group key changes between adjacent actions.
  function groupBoundary(actions, index) {
    if (index === 0) return false;
    return (actions[index - 1].group || actions[index - 1].id) !== (actions[index].group || actions[index].id);
  }

  const headerActions = $derived(appState.actions.filter(a => !a.feedbackContent));

  let promptCollapsed = $state(true);
  $effect(() => { appState.selected; promptCollapsed = true; });

  const sessionLinks = $derived.by(() => {
    const manual = appState.detail?.meta?.links ?? [];
    const pr = appState.prLink?.url ? [{ url: appState.prLink.url, label: "PR" }] : [];
    const prUrls = new Set(pr.map(l => l.url));
    return [...pr, ...manual.filter(l => !prUrls.has(l.url))];
  });

  let addingLink = $state(false);
  let newLinkUrl = $state("");
  let newLinkLabel = $state("");

  function linkDisplayLabel(link) {
    if (link.label) return link.label;
    try { return new URL(link.url).hostname; } catch { return link.url; }
  }

  async function onAddLink() {
    if (!newLinkUrl.trim() || !appState.selected) return;
    try {
      await addLink(appState.selected, newLinkUrl.trim(), newLinkLabel.trim() || undefined);
      newLinkUrl = "";
      newLinkLabel = "";
      addingLink = false;
    } catch (e) {
      toast(e.message);
    }
  }

  async function onRemoveLink(url) {
    if (!appState.selected) return;
    try {
      await removeLink(appState.selected, url);
    } catch (e) {
      toast(e.message);
    }
  }
</script>

{#if appState.selected && appState.detail}
  {@const m = appState.detail.meta}
  {@const events = (appState.detail.events ?? []).filter(isAgentWorkEvent)}
  {@const lastEvent = events.length > 0 ? events[events.length - 1] : null}
  <div class="detail-header">
    <div class="title"><span class="badge badge-{m.status}">{m.status.replace("_", " ")}</span>{m.title || m.prompt.slice(0, 100)}</div>
    <div class="header-actions">
      {#if headerActions.length > 0}
        {#each headerActions as a, i (a.id)}
          {#if groupBoundary(headerActions, i)}
            <span class="action-group-sep" aria-hidden="true"></span>
          {/if}
          {#if a.direct}
            <button class="btn-action" disabled={appState.actionRunInFlight} title={a.description || ""} onclick={() => runDirectAction(a.id)}>
              {#if appState.runningActionId === a.id}<span class="spinner"></span> {a.label}…{:else}{a.label}{/if}
            </button>
          {:else}
            <button class="btn-action" class:open={appState.openActionId === a.id} disabled={a.id === "create-pr" && prUrl !== null} title={a.id === "create-pr" && prUrl !== null ? "このブランチには既に PR があります" : (a.description || "")} onclick={() => toggleActionPanel(a.id)}>{a.label}</button>
          {/if}
        {/each}
        <span class="action-group-sep" aria-hidden="true"></span>
      {/if}
      <label class="revise-mode-toggle" title="On: worqload bounces the first submission of each report back to the session asking it to 推敲 (revise), then stores the resubmission. Off: the report is stored on first submission."><input type="checkbox" checked={m.reviseModeEnabled === true} onchange={() => onToggleReviseMode(m.id)} /><span>推敲モード</span></label>
    </div>
  </div>
  <div class="detail-original-prompt">
    <span class="prompt-header">
      <button type="button" class="prompt-toggle" aria-expanded={!promptCollapsed} onclick={() => (promptCollapsed = !promptCollapsed)}>
        <span class="prompt-caret" aria-hidden="true">{promptCollapsed ? "▸" : "▾"}</span> initial prompt
      </button><button type="button" class="copy-path-btn prompt-copy-btn" title="initial promptをコピー" onclick={() => navigator.clipboard.writeText(m.prompt).then(() => toast("prompt copied")).catch(() => toast("copy failed"))}>⧉</button>
    </span>
    {#if !promptCollapsed}<div class="prompt-body">{m.prompt}</div>{/if}
  </div>
  {#if sessionLinks.length > 0 || addingLink}
    <div class="session-links">
      {#each sessionLinks as link (link.url)}
        <span class="session-link-group">
          <a class="session-link-chip" href={link.url} target="_blank" rel="noopener">{linkDisplayLabel(link)}</a>
          {#if (appState.detail?.meta?.links ?? []).some(l => l.url === link.url)}
            <button class="link-remove-btn" title="リンクを削除" onclick={() => onRemoveLink(link.url)}>×</button>
          {/if}
        </span>
      {/each}
      {#if addingLink}
        <span class="link-add-form">
          <input class="link-add-input" type="text" placeholder="URL" bind:value={newLinkUrl} onkeydown={(e) => { if (e.key === "Enter") onAddLink(); if (e.key === "Escape") { addingLink = false; } }} />
          <input class="link-add-input link-add-label" type="text" placeholder="label" bind:value={newLinkLabel} onkeydown={(e) => { if (e.key === "Enter") onAddLink(); if (e.key === "Escape") { addingLink = false; } }} />
          <button class="link-add-ok" onclick={onAddLink}>+</button>
          <button class="link-add-cancel" onclick={() => { addingLink = false; }}>×</button>
        </span>
      {:else}
        <button class="link-add-btn" title="リンクを追加" onclick={() => { addingLink = true; }}>+</button>
      {/if}
    </div>
  {:else}
    <div class="session-links session-links-empty">
      <button class="link-add-btn" title="リンクを追加" onclick={() => { addingLink = true; }}>+</button>
    </div>
  {/if}
  <ActionBar />
  <div class="detail-meta">
    {#if m.agentName}agent: <code>{m.agentName}</code> · {/if}{#if m.agentName === "claude" || (!m.agentName)}model: <select class="model-switch-select" value={m.model || ""} onchange={(e) => onSwitchModel(m.id, e.target.value)}><option value="">(default)</option><optgroup label="Alias"><option value="sonnet">sonnet</option><option value="opus">opus</option><option value="haiku">haiku</option><option value="fable">fable</option></optgroup><optgroup label="Sonnet"><option value="claude-sonnet-5">claude-sonnet-5</option><option value="claude-sonnet-4-6">claude-sonnet-4-6</option><option value="claude-sonnet-4-6[1m]">claude-sonnet-4-6[1m]</option><option value="claude-sonnet-4-5">claude-sonnet-4-5</option></optgroup><optgroup label="Opus"><option value="claude-opus-5-5">claude-opus-5-5</option><option value="claude-opus-5">claude-opus-5</option><option value="claude-opus-4-8">claude-opus-4-8</option><option value="claude-opus-4-7">claude-opus-4-7</option><option value="claude-opus-4-7[1m]">claude-opus-4-7[1m]</option><option value="claude-opus-4-6">claude-opus-4-6</option><option value="claude-opus-4-6[1m]">claude-opus-4-6[1m]</option><option value="claude-opus-4-5">claude-opus-4-5</option></optgroup><optgroup label="Haiku"><option value="claude-haiku-4-5">claude-haiku-4-5</option></optgroup><optgroup label="Fable / Mythos"><option value="claude-fable-5-1">claude-fable-5-1</option><option value="claude-fable-5">claude-fable-5</option><option value="claude-mythos-5-1">claude-mythos-5-1</option><option value="claude-mythos-5">claude-mythos-5</option></optgroup></select>{:else if m.model}model: <code>{m.model}</code>{/if}
    {#if m.branchName}· branch: <code>{m.branchName}</code>{/if}
    {#if m.endedAt}· ended {formatRelative(m.endedAt)}{/if}
    · worktree: <code>{m.worktreePath}</code><button type="button" class="copy-path-btn" title="ディレクトリパスをコピー" onclick={() => navigator.clipboard.writeText(m.worktreePath).then(() => toast("path copied")).catch(() => toast("copy failed"))}>⧉</button>
    · <button type="button" class="meta-events-link" class:meta-events-warning={eventCountLevel(events.length) === "warning"} class:meta-events-danger={eventCountLevel(events.length) === "danger"} onclick={showEvents}>events</button>
  </div>
  <div class="tabs">
    {#each tabs as tab}
      <button class="tab-btn" class:active={appState.activeTab === tab.id} data-tab={tab.id} onclick={() => switchTab(tab.id)}>{tab.label}{#if tab.id === "reports" && reportsAttentionCount > 0} <span class="tab-count tab-count-unread" title={reportsAttentionTitle}>({reportsAttentionCount})</span>{/if}{#if tab.id === "events"} <span class="tab-count" class:tab-count-warning={eventCountLevel(events.length) === "warning"} class:tab-count-danger={eventCountLevel(events.length) === "danger"}>({events.length})</span><span class="tab-event-age" class:stale={lastEvent && eventAgeIsStale(lastEvent.timestamp, clock.now)} style={lastEvent ? null : "display:none"}>{lastEvent ? `· ${formatRelative(lastEvent.timestamp, clock.now)}` : ""}</span><span class="tab-dismiss" role="button" tabindex="0" title="Eventsタブを非表示" onclick={(e) => { e.stopPropagation(); toggleEventsTab(); switchTab("reports"); }} onkeydown={(e) => { if (e.key === "Enter") { e.stopPropagation(); toggleEventsTab(); switchTab("reports"); } }}>×</span>{/if}</button>
    {/each}
    {#if appState.activeTab === "diff"}
      <span class="diff-base-toggle">
        <button id="btnExpandAll" type="button" class="diff-tool-btn" onclick={onExpandAllDiffFiles}>Expand all</button>
        <button id="btnCollapseAll" type="button" class="diff-tool-btn" onclick={onCollapseAllDiffFiles}>Collapse all</button>
      </span>
    {/if}
  </div>
{/if}
