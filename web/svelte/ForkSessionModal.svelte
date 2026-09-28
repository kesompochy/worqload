<script>
  import { api, fetchSessions } from "../api.js";
  import { selectSession } from "../handlers.js";
  import { toast } from "../dom.js";

  let visible = $state(false);
  let sourceSession = $state(null);
  let prompt = $state("");
  let agentName = $state("claude");
  let model = $state("");
  let branchName = $state("");
  let startPaused = $state(false);
  let submitting = $state(false);
  let errorMessage = $state("");

  export function open(session) {
    sourceSession = session;
    prompt = "";
    agentName = session.agentName || "claude";
    model = session.model || "";
    branchName = "";
    startPaused = false;
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

  async function fork() {
    if (submitting) return;
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt === "") {
      toast("prompt is required");
      return;
    }
    submitting = true;
    errorMessage = "";
    try {
      const body = {
        prompt: trimmedPrompt,
        forkFrom: sourceSession.id,
        agentName,
      };
      const trimmedModel = model.trim();
      const trimmedBranchName = branchName.trim();
      if (agentName === "claude" && trimmedModel) body.model = trimmedModel;
      if (trimmedBranchName) body.branchName = trimmedBranchName;
      if (startPaused) body.startPaused = true;
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
      fork();
    }
  }
</script>

{#if visible && sourceSession}
  <div class="modal-bg">
    <div class="modal">
      <h2>Fork session</h2>
      <p style="margin:.2em 0 .4em; color:var(--text-dim); font-size:12px">
        Fork from: <strong>{sourceSession.title || sourceSession.prompt.slice(0, 60)}</strong>
      </p>
      <p style="margin:0 0 .6em; color:var(--text-dim); font-size:12px">
        Branch: <code>{sourceSession.branchName}</code>
      </p>
      <textarea
        bind:value={prompt}
        use:autofocus
        onkeydown={onPromptKeydown}
        placeholder="What should the forked session do?"
        rows="6"
      ></textarea>
      {#if errorMessage}
        <p class="create-error">Error: {errorMessage}</p>
      {/if}
      <div class="row" style="margin-top:.7rem">
        <label for="fork-session-agent" style="color:var(--text-dim); font-size:12px">Agent</label>
        <select id="fork-session-agent" bind:value={agentName} style="flex:1">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="cursor">Cursor</option>
        </select>
      </div>
      {#if agentName === "claude"}
        <div class="row" style="margin-top:.7rem">
          <label for="fork-session-model" style="color:var(--text-dim); font-size:12px">Model</label>
          <select id="fork-session-model" bind:value={model} style="flex:1">
            <option value="">(default)</option>
            <optgroup label="Alias (latest)">
              <option value="sonnet">sonnet</option>
              <option value="opus">opus</option>
              <option value="haiku">haiku</option>
              <option value="fable">fable</option>
            </optgroup>
            <optgroup label="Sonnet">
              <option value="claude-sonnet-5">claude-sonnet-5</option>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
              <option value="claude-sonnet-4-6[1m]">claude-sonnet-4-6[1m]</option>
              <option value="claude-sonnet-4-5">claude-sonnet-4-5</option>
            </optgroup>
            <optgroup label="Opus">
              <option value="claude-opus-5-5">claude-opus-5-5</option>
              <option value="claude-opus-5">claude-opus-5</option>
              <option value="claude-opus-4-8">claude-opus-4-8</option>
              <option value="claude-opus-4-7">claude-opus-4-7</option>
              <option value="claude-opus-4-7[1m]">claude-opus-4-7[1m]</option>
              <option value="claude-opus-4-6">claude-opus-4-6</option>
              <option value="claude-opus-4-6[1m]">claude-opus-4-6[1m]</option>
              <option value="claude-opus-4-5">claude-opus-4-5</option>
            </optgroup>
            <optgroup label="Haiku">
              <option value="claude-haiku-4-5">claude-haiku-4-5</option>
            </optgroup>
            <optgroup label="Fable / Mythos">
              <option value="claude-fable-5-1">claude-fable-5-1</option>
              <option value="claude-fable-5">claude-fable-5</option>
              <option value="claude-mythos-5-1">claude-mythos-5-1</option>
              <option value="claude-mythos-5">claude-mythos-5</option>
            </optgroup>
          </select>
        </div>
      {/if}
      <div class="row" style="margin-top:.7rem">
        <label style="color:var(--text-dim); font-size:12px; display:flex; align-items:center; gap:4px; cursor:pointer; white-space:nowrap; flex-shrink:0">
          <input type="checkbox" bind:checked={startPaused} />
          Start paused
        </label>
        <span class="spacer"></span>
        <button onclick={fork} disabled={submitting}>
          {#if submitting}<span class="spinner"></span> Forking…{:else}Fork{/if}
        </button>
        <button onclick={close} disabled={submitting}>Cancel</button>
      </div>
      <div class="row" style="margin-top:.7rem">
        <input bind:value={branchName} placeholder="branch name (default: auto-generated)" style="flex:1" />
      </div>
    </div>
  </div>
{/if}
