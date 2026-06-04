<script>
  // The left-sidebar session list. Mounted into #sessionList from main.ts.
  // Reads the reactive `appState` so it re-renders when the 30s poll, a streamed
  // event, or a user action changes appState.sessions / appState.selected /
  // appState.renamingSessionId; the lifecycle and rename calls live in handlers.js.
  // (`state` is imported as `appState` because a local binding named `state`
  // would make Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState } from "../state.svelte.js";
  import { formatRelative, eventAgeIsStale } from "../dom.js";
  import { clock } from "../clock.svelte.js";
  import {
    selectSession,
    onStop,
    onStopAndMarkRead,
    onStopAndResume,
    onArchive,
    onUnarchive,
    onResume,
    onRenameStart,
    onRenameCommit,
    onRenameCancel,
    onReorderSessions,
    onSidebarTab,
    onDeleteArchived,
    onToggleArchivedSelection,
    onSelectAllArchived,
    onClearArchivedSelection,
    onBulkDeleteArchived,
    onPruneArchivedOlderThan,
  } from "../handlers.js";

  // The sidebar's currently-shown feed: active sessions or the archives tab.
  // Card actions differ between the two (archived cards swap Stop/Archive for a
  // permanent Delete), and only the active list is drag-reorderable.
  const archivedView = $derived(appState.sidebarTab === "archived");
  const visibleSessions = $derived(archivedView ? appState.archivedSessions : appState.sessions);
  const selectionCount = $derived(appState.archivedSelection.size);
  const allArchivedSelected = $derived(
    archivedView && visibleSessions.length > 0 && selectionCount === visibleSessions.length,
  );

  // Tracked across the rename input's keydowns so a confirming Enter mid-IME
  // composition doesn't also commit the alias. Only one card renames at a time.
  let renameComposing = $state(false);

  // HTML5 drag-reorder of the cards. `draggedId` is the card being moved;
  // `dropBeforeId` is the card whose top edge shows the drop line (the dragged
  // card will land just before it), or — when the drop target is past the last
  // card — `dropAtEnd` is set instead and the last card shows a bottom line.
  let draggedId = $state(null);
  let dropBeforeId = $state(null);
  let dropAtEnd = $state(false);

  function resetDrag() {
    draggedId = null;
    dropBeforeId = null;
    dropAtEnd = false;
  }

  function onDragStart(event, sessionId) {
    draggedId = sessionId;
    event.dataTransfer.effectAllowed = "move";
    // Firefox won't emit dragover/drop unless some data is attached.
    event.dataTransfer.setData("text/plain", sessionId);
  }

  // The id the dragged card should land before if dropped on this card now:
  // the card itself when the pointer is in its top half, otherwise the next
  // card down (null past the last card → append).
  function dropBeforeFor(event, sessionId) {
    const rect = event.currentTarget.getBoundingClientRect();
    const inTopHalf = event.clientY - rect.top < rect.height / 2;
    if (inTopHalf) return sessionId;
    const index = appState.sessions.findIndex((s) => s.id === sessionId);
    return appState.sessions[index + 1]?.id ?? null;
  }
  // Drag-reorder only applies to the active tab (the archived list isn't
  // user-orderable — it's the result of a server filter), so the listeners
  // bail when archivedView is true.

  function onDragOver(event, sessionId) {
    if (!draggedId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const before = dropBeforeFor(event, sessionId);
    dropBeforeId = before;
    dropAtEnd = before === null;
  }

  function onDrop(event, sessionId) {
    event.preventDefault();
    const moved = draggedId;
    const before = dropBeforeFor(event, sessionId);
    resetDrag();
    onReorderSessions(moved, before);
  }

  function isTerminal(session) {
    return session.status === "stopped" || session.status === "crashed";
  }

  function statusLabel(status) {
    return status.replace("_", " ");
  }

  // Uncontrolled input: seed it once on mount and never let Svelte rewrite the
  // value, so the user's in-progress text survives the 30s poll re-render.
  function initRenameInput(node, initialTitle) {
    node.value = initialTitle ?? "";
    node.focus();
    node.select();
  }

  function selectOnEnter(event, sessionId) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectSession(sessionId);
    }
  }

  function onRenameKeydown(event, sessionId) {
    // The card wrapper turns Space/Enter into "select session", which clears
    // renamingSessionId and tears down this input. Keep the keystrokes here so
    // typing a space edits the alias instead of confirming the rename.
    event.stopPropagation();
    if (renameComposing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onRenameCancel();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onRenameCommit(sessionId, event.currentTarget.value);
    }
  }
</script>

<div class="sidebar-tabs" role="tablist" aria-label="Sessions">
  <button
    class="sidebar-tab"
    class:active={!archivedView}
    role="tab"
    aria-selected={!archivedView}
    onclick={() => onSidebarTab("active")}
  >Active</button>
  <button
    class="sidebar-tab"
    class:active={archivedView}
    role="tab"
    aria-selected={archivedView}
    onclick={() => onSidebarTab("archived")}
  >Archived</button>
</div>

{#if archivedView && selectionCount > 0}
  <div class="bulk-action-bar">
    <span class="bulk-count">{selectionCount} selected</span>
    <button
      class="bulk-select-all"
      onclick={() => (allArchivedSelected ? onClearArchivedSelection() : onSelectAllArchived())}
    >{allArchivedSelected ? "Clear" : "Select all"}</button>
    <button class="bulk-delete" onclick={onBulkDeleteArchived}>Delete {selectionCount}</button>
  </div>
{:else if archivedView && visibleSessions.length > 0}
  <div class="bulk-action-bar">
    <button class="bulk-delete" onclick={onPruneArchivedOlderThan}>古いアーカイブを削除…</button>
  </div>
{/if}

{#if visibleSessions.length === 0}
  <div style="padding:1rem; color:var(--text-dim)">{archivedView ? "No archived sessions." : "No sessions yet."}</div>
{:else}
  {#each visibleSessions as session, index (session.id)}
    {@const active = session.id === appState.selected}
    {@const terminal = isTerminal(session)}
    {@const renaming = active && session.id === appState.renamingSessionId}
    {@const unread = Number(session.unreadReportCount) || 0}
    {@const unresolvedEscalations = Number(session.unresolvedEscalationCount) || 0}
    {@const attention = unread + unresolvedEscalations}
    {@const isLast = index === visibleSessions.length - 1}
    {@const selected = archivedView && appState.archivedSelection.has(session.id)}
    <div
      class="session-card"
      class:active
      class:selected
      class:dragging={!archivedView && draggedId === session.id}
      class:drag-over={!archivedView && dropBeforeId === session.id && draggedId !== session.id}
      class:drag-over-end={!archivedView && dropAtEnd && isLast && draggedId !== session.id}
      role="button"
      tabindex="0"
      draggable={!archivedView && !renaming}
      ondragstart={(e) => !archivedView && onDragStart(e, session.id)}
      ondragover={(e) => !archivedView && onDragOver(e, session.id)}
      ondrop={(e) => !archivedView && onDrop(e, session.id)}
      ondragend={resetDrag}
      onclick={() => selectSession(session.id)}
      onkeydown={(e) => selectOnEnter(e, session.id)}
    >
      {#if archivedView}
        <!-- The label fills the card's left column so clicking anywhere in
             that strip toggles the checkbox; the only thing in that column is
             the checkbox, so a stray click there reads as "I meant to check
             this". stopPropagation on the label keeps the card-level onclick
             (= "select this session") out of it. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <label
          class="session-card-select-area"
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            class="session-card-select"
            checked={selected}
            aria-label="Select session for bulk delete"
            onchange={() => onToggleArchivedSelection(session.id)}
          />
        </label>
      {/if}
      <div class="session-card-main">
        {#if renaming}
          <p class="title"><span class="badge badge-{session.status}">{statusLabel(session.status)}</span></p>
          <input
            class="session-rename-input"
            type="text"
            maxlength="120"
            placeholder="alias（空欄でプロンプト先頭）"
            use:initRenameInput={session.title || ""}
            onclick={(e) => e.stopPropagation()}
            oncompositionstart={() => (renameComposing = true)}
            oncompositionend={() => (renameComposing = false)}
            onkeydown={(e) => onRenameKeydown(e, session.id)}
            onblur={(e) => onRenameCommit(session.id, e.currentTarget.value)}
          />
        {:else}
          <div class="session-card-title-row">
            <p class="title"><span class="badge badge-{session.status}">{statusLabel(session.status)}</span>{session.title || session.prompt.slice(0, 80)}</p>
            {#if active}
              <button class="btn-card-rename" onclick={(e) => { e.stopPropagation(); onRenameStart(session.id); }}>Rename</button>
            {/if}
          </div>
        {/if}
        <div class="meta">{#if session.agentName}{session.agentName} · {/if}{session.baseBranch} · {formatRelative(session.createdAt)}{#if !terminal && session.lastAgentEventAt} · last event <span class="session-event-age" class:stale={eventAgeIsStale(session.lastAgentEventAt, clock.now)}>{formatRelative(session.lastAgentEventAt, clock.now)}</span>{/if}</div>
        <div class="session-card-actions">
          {#if archivedView}
            <button class="btn-card-unarchive" onclick={(e) => { e.stopPropagation(); onUnarchive(session.id); }}>Unarchive</button>
            <button class="btn-card-delete" onclick={(e) => { e.stopPropagation(); onDeleteArchived(session.id); }}>Delete</button>
          {:else}
            {#if terminal}
              <button class="btn-card-resume" onclick={(e) => { e.stopPropagation(); onResume(session.id); }}>Resume</button>
            {:else}
              <button class="btn-card-stop-resume" title="Stop the host and resume it via `claude --continue` — for the case where the session is RUNNING but the agent has stopped consuming stdin" onclick={(e) => { e.stopPropagation(); onStopAndResume(session.id); }}>Stop &amp; resume</button>
              <button class="btn-card-stop" onclick={(e) => { e.stopPropagation(); onStop(session.id); }}>Stop</button>
              <button class="btn-card-stop-ack" title="Mark every report read, then stop the session" onclick={(e) => { e.stopPropagation(); onStopAndMarkRead(session.id); }}>Stop &amp; ack all</button>
            {/if}
            <button class="btn-card-archive" disabled={!terminal} onclick={(e) => { e.stopPropagation(); onArchive(session.id); }}>Archive</button>
          {/if}
        </div>
      </div>
      {#if attention > 0}
        {@const label = `未読レポート ${unread} + 未解決エスカレ ${unresolvedEscalations}`}
        <span class="unread-badge" aria-label={label} title={label}>{attention > 99 ? "99+" : attention}</span>
      {/if}
    </div>
  {/each}
{/if}
