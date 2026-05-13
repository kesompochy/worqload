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
  import { switchTab, onExpandAllDiffFiles, onCollapseAllDiffFiles, onStopAndMarkRead, toggleActionPanel } from "../handlers.js";
  import ActionBar from "./ActionBar.svelte";

  const tabs = [
    { id: "reports", label: "Reports" },
    { id: "feedback", label: "Feedbacks" },
    { id: "diff", label: "Diff" },
    { id: "files", label: "Files" },
    { id: "events", label: "Events" },
  ];

  // Feedback the agent has not fetched yet — the count the human still has "out".
  const unreadFeedbackCount = $derived(appState.feedbackHistory.filter(f => f.status === "unread").length);

  // Action buttons live in the title row, not in a strip below the tabs: a
  // tab-independent control under the tab bar competes with the mental model
  // that everything below the tabs belongs to the active tab.
  const isTerminal = $derived(
    appState.detail?.meta.status === "stopped" || appState.detail?.meta.status === "crashed",
  );
</script>

{#if appState.selected && appState.detail}
  {@const m = appState.detail.meta}
  {@const events = (appState.detail.events ?? []).filter(isAgentWorkEvent)}
  {@const lastEvent = events.length > 0 ? events[events.length - 1] : null}
  <div class="detail-header">
    <div class="title"><span class="badge badge-{m.status}">{m.status.replace("_", " ")}</span>{m.title || m.prompt.slice(0, 100)}</div>
    {#if appState.actions.length > 0 || !isTerminal}
      <div class="header-actions">
        {#if !isTerminal}
          <!-- A client-side composite (not a server "gh action"): mark every
               report read, then stop — pointless once already stopped/crashed. -->
          <button class="btn-action" title="Mark every report read, then stop the session" onclick={onStopAndMarkRead}>Stop &amp; mark all read</button>
        {/if}
        {#each appState.actions as a (a.id)}
          <button class="btn-action" class:open={appState.openActionId === a.id} title={a.description || ""} onclick={() => toggleActionPanel(a.id)}>{a.label}</button>
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
    · worktree: <code>{m.worktreePath}</code>
  </div>
  <div class="tabs">
    {#each tabs as tab}
      <button class="tab-btn" class:active={appState.activeTab === tab.id} data-tab={tab.id} onclick={() => switchTab(tab.id)}>{tab.label}{#if tab.id === "feedback" && unreadFeedbackCount > 0} <span class="tab-count tab-count-unread">({unreadFeedbackCount})</span>{/if}{#if tab.id === "events"} <span class="tab-count">({events.length})</span><span class="tab-event-age" class:stale={lastEvent && eventAgeIsStale(lastEvent.timestamp, clock.now)} style={lastEvent ? null : "display:none"}>{lastEvent ? `· ${formatRelative(lastEvent.timestamp, clock.now)}` : ""}</span>{/if}</button>
    {/each}
    {#if appState.activeTab === "diff"}
      <span class="diff-base-toggle">
        <button id="btnExpandAll" type="button" class="diff-tool-btn" onclick={onExpandAllDiffFiles}>Expand all</button>
        <button id="btnCollapseAll" type="button" class="diff-tool-btn" onclick={onCollapseAllDiffFiles}>Collapse all</button>
      </span>
    {/if}
  </div>
{/if}
