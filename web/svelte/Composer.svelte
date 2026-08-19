<script>
  // The detail pane's bottom composer: the feedback form for live sessions and
  // the resume-prompt form for terminal ones, plus the anchor chip when a diff/
  // file/report line is selected. Mounted into #detailComposer from main.ts;
  // renders nothing until a session with loaded detail is selected. Reads the
  // reactive `appState`, so it re-renders when the selected session, its status,
  // or the anchor changes — the textarea node persists across those updates, so
  // in-progress text survives without a manual save/restore.
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState, anchorLabel, TEMPLATES_STORAGE_KEY } from "../state.svelte.js";
  import { onFeedback, onQueueFeedback, removeQueuedFeedback, onResume, clearAnchor, copyAnchorPermalink, removeAttachment, onComposerPaste, onComposerDrop } from "../handlers.js";

  const skillActions = $derived(appState.actions.filter(a => a.feedbackContent));

  function loadCheckedTemplates() {
    try {
      const stored = localStorage.getItem(TEMPLATES_STORAGE_KEY);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  }

  let checkedTemplates = $state(loadCheckedTemplates());

  function toggleTemplate(id) {
    const next = new Set(checkedTemplates);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    checkedTemplates = next;
    try { localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify([...next])); } catch {}
  }

  function prependTemplates() {
    const checked = appState.feedbackTemplates.filter(t => checkedTemplates.has(t.id));
    if (checked.length === 0) return;
    const input = document.getElementById("feedbackInput");
    if (!input) return;
    const prefix = checked.map(t => t.text).join("\n");
    const existing = input.value.trim();
    input.value = existing ? `${prefix}\n\n${existing}` : prefix;
  }

  let skillFilter = $state("");
  let skillSelectedIndex = $state(0);
  let skillDropdownVisible = $state(false);

  const filteredSkills = $derived(
    skillFilter === ""
      ? skillActions
      : skillActions.filter(a => a.label.toLowerCase().includes(skillFilter.toLowerCase()))
  );

  function onSkillFilterInput() {
    skillSelectedIndex = 0;
    skillDropdownVisible = skillFilter !== "";
  }

  function onSkillFilterFocus() {
    if (skillFilter !== "") skillDropdownVisible = true;
  }

  function closeSkillDropdown() {
    skillDropdownVisible = false;
  }

  function selectSkill(feedbackContent) {
    const input = document.getElementById("feedbackInput");
    if (input) {
      const existing = input.value;
      const separator = existing !== "" && !existing.endsWith(" ") ? " " : "";
      input.value = existing + separator + feedbackContent;
      input.focus();
    }
    skillFilter = "";
    skillDropdownVisible = false;
  }

  function onSkillPickerKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      skillFilter = "";
      skillDropdownVisible = false;
      return;
    }
    if (!skillDropdownVisible) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      skillSelectedIndex = Math.min(skillSelectedIndex + 1, filteredSkills.length - 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      skillSelectedIndex = Math.max(skillSelectedIndex - 1, 0);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (filteredSkills.length > 0) {
        selectSkill(filteredSkills[skillSelectedIndex].feedbackContent);
      }
      return;
    }
  }

  // Tracked across the textarea's keydowns so a confirming Enter mid-IME
  // composition doesn't also submit (same guard as dom.js's bindInlineEdit).
  let composing = $state(false);

  function submit(isTerminal) {
    if (!isTerminal) prependTemplates();
    if (isTerminal) onResume();
    else onFeedback();
  }

  function onKeydown(event, isTerminal) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (composing || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!isTerminal && (event.ctrlKey || event.metaKey)) {
      prependTemplates();
      onQueueFeedback();
    } else {
      submit(isTerminal);
    }
  }

  // onFeedback/onResume read the textarea via getElementById("feedbackInput"),
  // so it stays an uncontrolled input keyed by that id rather than bind:value.
</script>

{#if appState.selected && appState.detail}
  {@const status = appState.detail.meta.status}
  {@const isTerminal = status === "stopped" || status === "crashed"}
  <form
    class="feedback-form"
    onsubmit={(e) => { e.preventDefault(); submit(isTerminal); }}
  >
    {#if appState.anchor && !isTerminal}
      <!-- Anchored comments target the feedback inbox; the resume composer
           (terminal sessions) sends a plain prompt, so the chip is hidden there. -->
      <div class="anchor-chip">Re: {anchorLabel(appState.anchor)} <button type="button" title="GitHub permalink をコピー" onclick={copyAnchorPermalink}>🔗</button> <button type="button" title="clear anchor" onclick={clearAnchor}>×</button></div>
      {#if appState.anchor.quote}
        <blockquote class="anchor-quote">{appState.anchor.quote}</blockquote>
      {/if}
    {/if}
    {#if !isTerminal && appState.pendingAttachments.length > 0}
      <!-- Image chips queued for the next submit. The list is shared with the
           floating anchored composer; whichever submits empties it. -->
      <div class="attachment-chips">
        {#each appState.pendingAttachments as att (att.id)}
          <span class="attachment-chip" title="{att.file.name}">
            <img src={att.previewUrl} alt={att.file.name} />
            <span class="attachment-chip-name">{att.file.name}</span>
            <button type="button" title="remove" onclick={() => removeAttachment(att.id)}>×</button>
          </span>
        {/each}
      </div>
    {/if}
    {#if !isTerminal && appState.feedbackQueue.length > 0}
      <div class="feedback-queue">
        <div class="feedback-queue-header">Queued ({appState.feedbackQueue.length})</div>
        {#each appState.feedbackQueue as item, i (i)}
          <div class="feedback-queue-item">
            <span class="feedback-queue-text">{item.content}</span>
            <button type="button" title="remove" class="feedback-queue-remove" onclick={() => removeQueuedFeedback(i)}>×</button>
          </div>
        {/each}
      </div>
    {/if}
    {#if !isTerminal && appState.feedbackTemplates.length > 0}
      <div class="feedback-templates">
        {#each appState.feedbackTemplates as tmpl (tmpl.id)}
          <label class="feedback-template-label">
            <input type="checkbox" checked={checkedTemplates.has(tmpl.id)} onchange={() => toggleTemplate(tmpl.id)} />
            {tmpl.label}
          </label>
        {/each}
      </div>
    {/if}
    <textarea
      id="feedbackInput"
      rows="3"
      placeholder={isTerminal
        ? "Instructions for the resumed session (optional — picked up via worqload feedback fetch). Enter で再開 / Shift+Enter で改行"
        : appState.anchor
          ? "Comment on the selected lines... (Enter で送信 / Ctrl+Enter でキューに追加 / Shift+Enter で改行)"
          : "Plain feedback. Enter で送信 / Ctrl+Enter でキューに追加して一括送信 / Shift+Enter で改行"}
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => (composing = false)}
      onkeydown={(e) => onKeydown(e, isTerminal)}
      onpaste={(e) => { if (!isTerminal) onComposerPaste(e); }}
      ondragover={(e) => { if (!isTerminal) e.preventDefault(); }}
      ondrop={(e) => { if (!isTerminal) onComposerDrop(e); }}
    ></textarea>
    <div class="row">
      {#if !isTerminal}
        {@const noSkills = skillActions.length === 0}
        <div class="skill-picker-wrapper">
          <input
            type="text"
            class="skill-picker-input"
            placeholder="/skill..."
            disabled={noSkills}
            title={noSkills ? "config の skillPaths にスキルディレクトリを登録すると有効になります" : ""}
            bind:value={skillFilter}
            oninput={onSkillFilterInput}
            onfocus={onSkillFilterFocus}
            onkeydown={onSkillPickerKeydown}
            onblur={() => { setTimeout(closeSkillDropdown, 150); }}
          />
          {#if skillDropdownVisible && filteredSkills.length > 0}
            <div class="skill-picker-dropdown">
              <ul class="skill-picker-list" role="listbox">
                {#each filteredSkills as skill, i (skill.id)}
                  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
                  <li class="skill-picker-item" role="option" aria-selected={i === skillSelectedIndex} class:selected={i === skillSelectedIndex} onmouseenter={() => { skillSelectedIndex = i; }} onclick={() => selectSkill(skill.feedbackContent)}>
                    <span class="skill-picker-name">/{skill.label}</span>
                    {#if skill.description}<span class="skill-picker-desc">{skill.description}</span>{/if}
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      {/if}
      <span class="spacer"></span>
      <button type="submit">{isTerminal ? "Resume session" : "Send feedback"}</button>
    </div>
  </form>
{/if}
