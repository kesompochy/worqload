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
  let baseBranch = $state("");
  let branchName = $state("");
  let submitting = $state(false);

  export function open() {
    prompt = "";
    baseBranch = "";
    branchName = "";
    submitting = false;
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
    try {
      const body = { prompt: trimmedPrompt };
      const trimmedBase = baseBranch.trim();
      const trimmedBranchName = branchName.trim();
      if (trimmedBase) body.baseBranch = trimmedBase;
      if (trimmedBranchName) body.branchName = trimmedBranchName;
      const { meta } = await api("POST", "/sessions", body);
      visible = false;
      await fetchSessions();
      await selectSession(meta.id);
    } catch (e) {
      toast(`failed: ${e.message}`);
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
        The prompt becomes the first user message in a fresh claude session.
      </p>
      <textarea
        bind:value={prompt}
        use:autofocus
        onkeydown={onPromptKeydown}
        placeholder="What should the agent do?"
        rows="6"
      ></textarea>
      <div class="row" style="margin-top:.7rem">
        <input bind:value={baseBranch} placeholder="base branch (default: current HEAD)" style="flex:1" />
      </div>
      <div class="row" style="margin-top:.7rem">
        <input bind:value={branchName} placeholder="branch name (default: auto-generated)" style="flex:1" />
      </div>
      <div class="row" style="margin-top:.7rem">
        <span class="spacer"></span>
        <button onclick={close} disabled={submitting}>Cancel</button>
        <button onclick={create} disabled={submitting}>
          {#if submitting}<span class="spinner"></span> Creating…{:else}Create{/if}
        </button>
      </div>
    </div>
  </div>
{/if}
