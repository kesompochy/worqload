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
  import { switchTab, onExpandAllDiffFiles, onCollapseAllDiffFiles, toggleActionPanel, runDirectAction, onToggleReviseMode } from "../handlers.js";
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

  // Collapses the initial-prompt block — a long opening prompt otherwise eats
  // vertical space above the tabs. Persists across session switches because the
  // header stays mounted; that's intentional, treated as a viewing preference.
  const headerActions = $derived(appState.actions.filter(a => !a.feedbackContent));

  let promptCollapsed = $state(true);
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
          {#if a.id === "create-pr" && prUrl}
            <a class="pr-link-chip" href={prUrl} target="_blank" rel="noopener" title="このブランチの PR を開く">PR</a>
          {/if}
        {/each}
        <span class="action-group-sep" aria-hidden="true"></span>
      {/if}
      <label class="revise-mode-toggle" title="On: worqload bounces the first submission of each report back to the session asking it to 推敲 (revise), then stores the resubmission. Off: the report is stored on first submission."><input type="checkbox" checked={m.reviseModeEnabled === true} onchange={() => onToggleReviseMode(m.id)} /><span>推敲モード</span></label>
    </div>
  </div>
  <div class="detail-original-prompt">
    <button type="button" class="prompt-toggle" aria-expanded={!promptCollapsed} onclick={() => (promptCollapsed = !promptCollapsed)}>
      <span class="prompt-caret" aria-hidden="true">{promptCollapsed ? "▸" : "▾"}</span> initial prompt
    </button>
    {#if !promptCollapsed}<div class="prompt-body">{m.prompt}</div>{/if}
  </div>
  <ActionBar />
  <div class="detail-meta">
    {#if m.agentName}agent: <code>{m.agentName}</code> · {/if}{#if m.model}model: <code>{m.model}</code> · {/if}base: <code>{m.baseBranch}</code>
    {#if m.branchName}· branch: <code>{m.branchName}</code>{/if}
    · started {formatRelative(m.createdAt)}
    {#if m.endedAt}· ended {formatRelative(m.endedAt)}{/if}
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
