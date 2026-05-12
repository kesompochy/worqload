<script>
  // The detail pane's top strip: title + status badge, the metadata line, and
  // the tab bar. Mounted into #detailHeader from main.ts; renders nothing until
  // a session with loaded detail is selected. The action bar / action panels
  // (#detailActionArea) and the feedback/resume composer (#detailComposer) are
  // still rebuilt by render.js's renderDetail(); everything else below is
  // DetailBody.svelte. The Events tab's "· Ns ago" label reads the reactive
  // `clock` so it counts up between streamed events.
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState } from "../state.svelte.js";
  import { formatRelative } from "../dom.js";
  import { clock } from "../clock.svelte.js";
  import { switchTab, onExpandAllDiffFiles, onCollapseAllDiffFiles } from "../handlers.js";

  const tabs = [
    { id: "reports", label: "Reports" },
    { id: "diff", label: "Diff" },
    { id: "files", label: "Files" },
    { id: "events", label: "Events" },
  ];
</script>

{#if appState.selected && appState.detail}
  {@const m = appState.detail.meta}
  {@const events = appState.detail.events ?? []}
  {@const lastEvent = events.length > 0 ? events[events.length - 1] : null}
  <div class="detail-header">
    <div class="title"><span class="badge badge-{m.status}">{m.status.replace("_", " ")}</span>{m.title || m.prompt.slice(0, 100)}</div>
  </div>
  <div class="detail-meta">
    base: <code>{m.baseBranch}</code>
    {#if m.branchName}· branch: <code>{m.branchName}</code>{/if}
    · started {formatRelative(m.createdAt)}
    {#if m.endedAt}· ended {formatRelative(m.endedAt)}{/if}
    · worktree: <code>{m.worktreePath}</code>
  </div>
  <div class="tabs">
    {#each tabs as tab}
      <button class="tab-btn" class:active={appState.activeTab === tab.id} data-tab={tab.id} onclick={() => switchTab(tab.id)}>{tab.label}{#if tab.id === "events"} <span class="tab-count">({events.length})</span><span class="tab-event-age" style={lastEvent ? null : "display:none"}>{lastEvent ? `· ${formatRelative(lastEvent.timestamp, clock.now)}` : ""}</span>{/if}</button>
    {/each}
    {#if appState.activeTab === "diff"}
      <span class="diff-base-toggle">
        <button id="btnExpandAll" type="button" class="diff-tool-btn" onclick={onExpandAllDiffFiles}>Expand all</button>
        <button id="btnCollapseAll" type="button" class="diff-tool-btn" onclick={onCollapseAllDiffFiles}>Collapse all</button>
      </span>
    {/if}
  </div>
{/if}
