<script>
  // The detail pane's action strip and the inline panel for a "gh action",
  // mounted into #detailActionArea from main.ts. Sits above the scroll body
  // (DetailBody.svelte); the composer below it is still rebuilt by render.js's
  // renderDetail() into #detailComposer. The actions deliberately use an
  // inline panel rather than a modal: the run log stays on screen alongside
  // the rest of the session, and (because the server records each run as an
  // action_invoked event) it survives a reload. The confirmation step is the
  // explicit "Confirm & Run" button in the panel head — a short reach from the
  // button that opened the panel; the panel is the gate, not a separate dialog.
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState } from "../state.svelte.js";
  import { formatRelative } from "../dom.js";
  import { clock } from "../clock.svelte.js";
  import { onStopAndMarkRead, toggleActionPanel, runOpenAction } from "../handlers.js";

  const isTerminal = $derived(
    appState.detail?.meta.status === "stopped" || appState.detail?.meta.status === "crashed",
  );
  const openAction = $derived(appState.actions.find(a => a.id === appState.openActionId) ?? null);

  // Newest run for the open action: the in-view cache (freshest, written by
  // runOpenAction) falls back to the latest action_invoked event so a run made
  // before this page load is still shown when the panel is opened.
  function lastRunFor(actionId) {
    const cached = appState.actionResults.get(actionId);
    if (cached) return cached;
    const events = appState.detail?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.kind === "action_invoked" && ev.payload && ev.payload.actionId === actionId) {
        return { ...ev.payload, ranAt: ev.timestamp };
      }
    }
    return null;
  }
  const lastRun = $derived(openAction ? lastRunFor(openAction.id) : null);

  let panelEl = $state();
  // Opening a panel (or switching to a different action) puts the cursor in its
  // first parameter field, so the human can start typing without a second click.
  $effect(() => {
    void appState.openActionId;
    panelEl?.querySelector("[data-action-param]")?.focus();
  });
</script>

{#if appState.selected && appState.detail}
  {#if appState.actions.length > 0 || !isTerminal}
    <div class="action-bar">
      <span class="label">Actions</span>
      <div class="buttons">
        {#if !isTerminal}
          <!-- A client-side composite (not a server "gh action"): mark every
               report read, then stop — pointless once already stopped/crashed. -->
          <button class="btn-action" title="Mark every report read, then stop the session" onclick={onStopAndMarkRead}>Stop &amp; mark all read</button>
        {/if}
        {#each appState.actions as a (a.id)}
          <button class="btn-action" class:open={appState.openActionId === a.id} title={a.description || ""} onclick={() => toggleActionPanel(a.id)}>{a.label}</button>
        {/each}
      </div>
    </div>
  {/if}

  {#if openAction}
    {#key openAction.id}
      <div class="action-panel" bind:this={panelEl}>
        <div class="action-panel-head">
          <strong>{openAction.label}</strong>
          <button class="action-run" disabled={appState.actionRunInFlight} onclick={runOpenAction}>
            {#if appState.actionRunInFlight}<span class="spinner"></span> Running…{:else}{openAction.confirmMessage ? "Confirm & Run" : "Run"}{/if}
          </button>
          {#if openAction.description}<span class="desc">{openAction.description}</span>{/if}
          <span class="spacer"></span>
          <button class="close" title="Close" onclick={() => toggleActionPanel(openAction.id)}>×</button>
        </div>
        {#if openAction.confirmMessage}
          <div class="action-confirm">⚠ {openAction.confirmMessage}</div>
        {/if}
        {#if (openAction.params || []).length > 0}
          <div class="action-form">
            {#each openAction.params as p (p.name)}
              <label for="actionParam-{p.name}">{p.label}</label>
              {#if p.type === "text"}
                <textarea id="actionParam-{p.name}" data-action-param={p.name} rows="4" placeholder={p.placeholder || ""} value={p.default || ""}></textarea>
              {:else}
                <input id="actionParam-{p.name}" data-action-param={p.name} type="text" placeholder={p.placeholder || ""} value={p.default || ""} />
              {/if}
            {/each}
          </div>
        {/if}
        <div class="action-output">
          {#if !lastRun}
            <div class="empty">No run yet — press Run above. Past runs stay here and in the Events tab.</div>
          {:else}
            {#if lastRun.ok}
              <div class="status-ok">✓ Success (exit {lastRun.exitCode ?? 0}){#if lastRun.ranAt}<span class="ran-at">{formatRelative(lastRun.ranAt, clock.now)}</span>{/if}</div>
            {:else}
              <div class="status-fail">✗ Failed{lastRun.exitCode !== undefined && lastRun.exitCode !== null ? ` (exit ${lastRun.exitCode})` : ""}{#if lastRun.ranAt}<span class="ran-at">{formatRelative(lastRun.ranAt, clock.now)}</span>{/if}</div>
            {/if}
            {#if lastRun.message}<div style="margin-top:.3rem">{lastRun.message}</div>{/if}
            {#if lastRun.stdout && lastRun.stdout.trim() !== ""}<h3>stdout</h3><pre>{lastRun.stdout}</pre>{/if}
            {#if lastRun.stderr && lastRun.stderr.trim() !== ""}<h3>stderr</h3><pre>{lastRun.stderr}</pre>{/if}
          {/if}
        </div>
      </div>
    {/key}
  {/if}
{/if}
