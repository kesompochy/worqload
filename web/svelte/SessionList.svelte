<script>
  // The left-sidebar session list. Mounted into #sessionList from main.ts.
  // Reads the reactive `appState` so it re-renders when the 30s poll, a streamed
  // event, or a user action changes appState.sessions / appState.selected /
  // appState.renamingSessionId; the lifecycle and rename calls live in handlers.js.
  // (`state` is imported as `appState` because a local binding named `state`
  // would make Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState } from "../state.svelte.js";
  import { formatRelative } from "../dom.js";
  import {
    selectSession,
    onStop,
    onArchive,
    onResume,
    onRenameStart,
    onRenameCommit,
    onRenameCancel,
    onReorderSessions,
  } from "../handlers.js";

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

{#if appState.sessions.length === 0}
  <div style="padding:1rem; color:var(--text-dim)">No sessions yet.</div>
{:else}
  {#each appState.sessions as session, index (session.id)}
    {@const active = session.id === appState.selected}
    {@const terminal = isTerminal(session)}
    {@const renaming = active && session.id === appState.renamingSessionId}
    {@const unread = Number(session.unreadReportCount) || 0}
    {@const isLast = index === appState.sessions.length - 1}
    <div
      class="session-card"
      class:active
      class:dragging={draggedId === session.id}
      class:drag-over={dropBeforeId === session.id && draggedId !== session.id}
      class:drag-over-end={dropAtEnd && isLast && draggedId !== session.id}
      role="button"
      tabindex="0"
      draggable={!renaming}
      ondragstart={(e) => onDragStart(e, session.id)}
      ondragover={(e) => onDragOver(e, session.id)}
      ondrop={(e) => onDrop(e, session.id)}
      ondragend={resetDrag}
      onclick={() => selectSession(session.id)}
      onkeydown={(e) => selectOnEnter(e, session.id)}
    >
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
          <p class="title"><span class="badge badge-{session.status}">{statusLabel(session.status)}</span>{session.title || session.prompt.slice(0, 80)}</p>
        {/if}
        <div class="meta">{session.baseBranch} · {formatRelative(session.createdAt)}</div>
        <div class="session-card-actions">
          {#if active && !renaming}
            <button class="btn-card-rename" onclick={(e) => { e.stopPropagation(); onRenameStart(session.id); }}>Rename</button>
          {/if}
          {#if terminal}
            <button class="btn-card-resume" onclick={(e) => { e.stopPropagation(); onResume(session.id); }}>Resume</button>
          {:else}
            <button class="btn-card-stop" onclick={(e) => { e.stopPropagation(); onStop(session.id); }}>Stop</button>
          {/if}
          <button class="btn-card-archive" disabled={!terminal} onclick={(e) => { e.stopPropagation(); onArchive(session.id); }}>Archive</button>
        </div>
      </div>
      {#if unread > 0}
        <span class="unread-badge" aria-label="{unread} unread report{unread === 1 ? '' : 's'}" title="{unread} unread report{unread === 1 ? '' : 's'}">{unread > 99 ? "99+" : unread}</span>
      {/if}
    </div>
  {/each}
{/if}
