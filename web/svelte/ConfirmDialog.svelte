<script>
  // The in-page confirm / input dialog opened by requestConfirmation /
  // requestInput (handlers.js). Escape or the backdrop cancels; Enter in the
  // input accepts unless an IME composition is being committed.
  import { onMount } from "svelte";
  import { resolveDialog } from "../handlers.js";
  import { state } from "../state.svelte.js";

  function accept() {
    resolveDialog(state.dialog.input === null ? true : state.dialog.input);
  }

  function cancel() {
    resolveDialog(state.dialog.input === null ? false : null);
  }

  function onInputKeydown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") { e.preventDefault(); accept(); }
  }

  function onKeydown(e) {
    if (state.dialog && e.key === "Escape") { e.preventDefault(); cancel(); }
  }

  function autofocus(node) {
    node.focus();
    node.select?.();
  }

  onMount(() => {
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if state.dialog}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-bg" onclick={(e) => { if (e.target === e.currentTarget) cancel(); }}>
    <div class="modal confirm-dialog" role="dialog" aria-modal="true">
      <p class="confirm-dialog-message">{state.dialog.message}</p>
      {#if state.dialog.input !== null}
        <input bind:value={state.dialog.input} use:autofocus onkeydown={onInputKeydown} />
      {/if}
      <div class="row" style="margin-top:.7rem">
        <span class="spacer"></span>
        {#if state.dialog.input === null}
          <button use:autofocus onclick={accept}>{state.dialog.confirmLabel}</button>
        {:else}
          <button onclick={accept}>{state.dialog.confirmLabel}</button>
        {/if}
        <button onclick={cancel}>キャンセル</button>
      </div>
    </div>
  </div>
{/if}
