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
  import { formatRelative, eventAgeIsStale } from "../dom.js";
  import { isAgentWorkEvent } from "../events-view.js";
  import { clock } from "../clock.svelte.js";
  import { switchTab, onExpandAllDiffFiles, onCollapseAllDiffFiles, toggleActionPanel, runDirectAction, onToggleReportAgent } from "../handlers.js";
  import ActionBar from "./ActionBar.svelte";

  const tabs = [
    { id: "reports", label: "Reports" },
    { id: "feedback", label: "Feedbacks" },
    { id: "diff", label: "Diff" },
    { id: "files", label: "Files" },
    { id: "structure", label: "Structure" },
    { id: "events", label: "Events" },
  ];

  // The selected session's outstanding work asking for the human's attention:
  // reports not yet marked read, plus escalations that pause the agent's turn
  // until answered. Surfaced as a single badge on the Reports tab so the human
  // notices unacked items even while viewing another tab (Diff / Events / ...).
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
</script>

{#if appState.selected && appState.detail}
  {@const m = appState.detail.meta}
  {@const events = (appState.detail.events ?? []).filter(isAgentWorkEvent)}
  {@const lastEvent = events.length > 0 ? events[events.length - 1] : null}
  <div class="detail-header">
    <div class="title"><span class="badge badge-{m.status}">{m.status.replace("_", " ")}</span>{m.title || m.prompt.slice(0, 100)}</div>
    {#if appState.actions.length > 0}
      <div class="header-actions">
        {#each appState.actions as a, i (a.id)}
          {#if groupBoundary(appState.actions, i)}
            <span class="action-group-sep" aria-hidden="true"></span>
          {/if}
          {#if a.direct}
            <button class="btn-action" disabled={appState.actionRunInFlight} title={a.description || ""} onclick={() => runDirectAction(a.id)}>
              {#if appState.runningActionId === a.id}<span class="spinner"></span> {a.label}…{:else}{a.label}{/if}
            </button>
          {:else}
            <button class="btn-action" class:open={appState.openActionId === a.id} title={a.description || ""} onclick={() => toggleActionPanel(a.id)}>{a.label}</button>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
  <ActionBar />
  <div class="detail-meta">
    base: <code>{m.baseBranch}</code>
    {#if m.branchName}· branch: <code>{m.branchName}</code>{/if}
    · started {formatRelative(m.createdAt)}
    {#if m.endedAt}· ended {formatRelative(m.endedAt)}{/if}
    · <label class="report-agent-toggle" title="On: worqload runs a disposable report-only agent over each report (結論ファースト・短文に整形) before storing it. Off: the report is stored as the session wrote it."><input type="checkbox" checked={m.reportAgentEnabled !== false} onchange={() => onToggleReportAgent(m.id)} /><span>レポート整形</span></label>
    · worktree: <code>{m.worktreePath}</code>
  </div>
  <div class="tabs">
    {#each tabs as tab}
      <button class="tab-btn" class:active={appState.activeTab === tab.id} data-tab={tab.id} onclick={() => switchTab(tab.id)}>{tab.label}{#if tab.id === "reports" && reportsAttentionCount > 0} <span class="tab-count tab-count-unread" title={reportsAttentionTitle}>({reportsAttentionCount})</span>{/if}{#if tab.id === "events"} <span class="tab-count">({events.length})</span><span class="tab-event-age" class:stale={lastEvent && eventAgeIsStale(lastEvent.timestamp, clock.now)} style={lastEvent ? null : "display:none"}>{lastEvent ? `· ${formatRelative(lastEvent.timestamp, clock.now)}` : ""}</span>{/if}</button>
    {/each}
    {#if appState.activeTab === "diff"}
      <span class="diff-base-toggle">
        <button id="btnExpandAll" type="button" class="diff-tool-btn" onclick={onExpandAllDiffFiles}>Expand all</button>
        <button id="btnCollapseAll" type="button" class="diff-tool-btn" onclick={onCollapseAllDiffFiles}>Collapse all</button>
      </span>
    {/if}
  </div>
{/if}
