<script>
  // The "New session" dialog. Opened via the exported open() (wired to the
  // sidebar's "+ New" button in main.ts); on submit it POSTs /sessions, then
  // refreshes the sidebar and selects the new session — the same flow the old
  // vanilla createSession() ran, minus the manual DOM bookkeeping.
  import { api, fetchSessions } from "../api.js";
  import { selectSession } from "../handlers.js";
  import { toast } from "../dom.js";

  let visible = $state(false);
  let prompt = $state("");
  let agentName = $state("claude");
  let model = $state("");
  let baseBranch = $state("");
  let branchName = $state("");
  let submitting = $state(false);
  let errorMessage = $state("");

  export function open() {
    prompt = "";
    agentName = "claude";
    model = "";
    baseBranch = "";
    branchName = "";
    submitting = false;
    errorMessage = "";
    visible = true;
  }

  function close() {
    if (submitting) return;
    visible = false;
  }

  function autofocus(node) {
    node.focus();
  }

  async function create() {
    if (submitting) return;
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt === "") {
      toast("prompt is required");
      return;
    }
    submitting = true;
    errorMessage = "";
    try {
      const body = { prompt: trimmedPrompt, agentName };
      const trimmedModel = model.trim();
      const trimmedBase = baseBranch.trim();
      const trimmedBranchName = branchName.trim();
      if (agentName === "claude" && trimmedModel) body.model = trimmedModel;
      if (trimmedBase) body.baseBranch = trimmedBase;
      if (trimmedBranchName) body.branchName = trimmedBranchName;
      const { meta } = await api("POST", "/sessions", body);
      visible = false;
      await fetchSessions();
      await selectSession(meta.id);
    } catch (e) {
      errorMessage = e.message;
    } finally {
      submitting = false;
    }
  }

  function onPromptKeydown(e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      create();
    }
  }
</script>

{#if visible}
  <div class="modal-bg">
    <div class="modal">
      <h2>New session</h2>
      <p style="margin:.2em 0 .6em; color:var(--text-dim); font-size:12px">
        The prompt becomes the first user message in a fresh agent session.
      </p>
      <textarea
        bind:value={prompt}
        use:autofocus
        onkeydown={onPromptKeydown}
        placeholder="What should the agent do?"
        rows="6"
      ></textarea>
      {#if errorMessage}
        <p class="create-error">Error: {errorMessage}</p>
      {/if}
      <div class="row" style="margin-top:.7rem">
        <label for="new-session-agent" style="color:var(--text-dim); font-size:12px">Agent</label>
        <select id="new-session-agent" bind:value={agentName} style="flex:1">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="cursor">Cursor</option>
        </select>
      </div>
      {#if agentName === "claude"}
        <div class="row" style="margin-top:.7rem">
          <label for="new-session-model" style="color:var(--text-dim); font-size:12px">Model</label>
          <select id="new-session-model" bind:value={model} style="flex:1">
            <option value="">(default)</option>
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
            <option value="haiku">Haiku</option>
            <option value="fable">Fable</option>
          </select>
        </div>
      {/if}
      <div class="row" style="margin-top:.7rem">
        <span class="spacer"></span>
        <button onclick={create} disabled={submitting}>
          {#if submitting}<span class="spinner"></span> Creating…{:else}Create{/if}
        </button>
        <button onclick={close} disabled={submitting}>Cancel</button>
      </div>
      <div class="row" style="margin-top:.7rem">
        <input bind:value={baseBranch} placeholder="base branch (default: current HEAD)" style="flex:1" />
      </div>
      <div class="row" style="margin-top:.7rem">
        <input bind:value={branchName} placeholder="branch name (default: auto-generated)" style="flex:1" />
      </div>
    </div>
  </div>
{/if}
