<script>
  // The detail pane's scroll body — everything between the header (DetailHeader)
  // and the composer/action area (still built by render.js's renderDetail into
  // #detailActionArea / #detailComposer): the pending-asking section, the
  // active tab's content, and the "Feedback sent" list. Mounted into
  // #detailBodyMount from main.ts. The Reports tab, the Feedback-sent list, and
  // the asking section are rendered natively here off the reactive `appState`;
  // the Diff / Files / Events tabs still come from the *-view modules as HTML
  // strings via {@html} (those will be migrated next). Click handling for the
  // {@html} tabs, for line anchors inside report markdown, and for the asking
  // buttons is delegated to handlers.js's onDetailBodyClick.
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { tick } from "svelte";
  import { state as appState, isReportExpanded, isFeedbackExpanded } from "../state.svelte.js";
  import { renderMarkdown } from "../markdown.js";
  import { renderDiffHtml } from "../diff-view.js";
  import { renderFilesHtml } from "../files-view.js";
  import { renderEventsHtml } from "../events-view.js";
  import { onDetailBodyClick } from "../handlers.js";

  // Reports are stored oldest-first; the pane shows newest-first.
  const reportsNewestFirst = $derived([...appState.reports].reverse());

  // The {@html} tab bodies replace their whole subtree on every reactive
  // change (a streamed event re-renders the Events list; an anchor click
  // re-highlights the Diff lines), and the Reports list prepends a freshly
  // arrived report above whatever the user is reading — both snap the scroll
  // position. These mirror render.js's old captureDetailScroll/restoreDetailScroll:
  // anchor to the topmost row still reaching into the viewport (rows carry stable
  // data-* ids) rather than reusing scrollTop, so prepended rows don't shift the
  // view; sitting exactly at the top is preserved as-is. When the active tab
  // changes the anchor row is gone, so the outgoing tab's position is stashed in
  // appState.tabScroll and the incoming tab's stashed position restored.
  const SCROLL_ANCHOR_ATTRS = ["data-event-seq", "data-report-filename", "data-feedback-filename", "data-diff-path", "data-asking"];
  let bodyEl = $state();
  let renderedTab = appState.activeTab;

  function captureScroll() {
    if (!bodyEl) return null;
    if (bodyEl.scrollTop <= 0) return { atTop: true };
    const bodyTop = bodyEl.getBoundingClientRect().top;
    for (const el of bodyEl.querySelectorAll(SCROLL_ANCHOR_ATTRS.map(a => `[${a}]`).join(","))) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= bodyTop) continue; // entirely scrolled past
      for (const attr of SCROLL_ANCHOR_ATTRS) {
        const value = el.getAttribute(attr);
        if (value) return { attr, value, offset: rect.top - bodyTop };
      }
    }
    return { scrollTop: bodyEl.scrollTop };
  }

  function restoreScroll(saved) {
    if (!saved || saved.atTop || !bodyEl) return;
    if (saved.scrollTop !== undefined) { bodyEl.scrollTop = saved.scrollTop; return; }
    const el = bodyEl.querySelector(`[${saved.attr}=${CSS.escape(saved.value)}]`);
    if (!el) return; // the anchored row is gone — leave the rebuilt body at its top
    const offset = el.getBoundingClientRect().top - bodyEl.getBoundingClientRect().top;
    bodyEl.scrollTop += offset - saved.offset;
  }

  $effect.pre(() => {
    // Touch every reactive input that changes what the body renders, so this
    // runs (before the DOM update) whenever any of them changes.
    void appState.activeTab;
    void appState.reports.length;
    void appState.feedbackHistory.length;
    void appState.asking.length;
    void appState.anchor;
    void appState.diff;
    void appState.collapsedFiles.size;
    void appState.diffExpansions.size;
    void appState.files.length;
    void appState.fileTreeCollapsed.size;
    void appState.selectedFilePath;
    void appState.fileContent;
    void appState.eventToggle.size;
    void appState.reportToggle.size;
    void appState.feedbackToggle.size;
    void appState.detail?.events?.length;
    void appState.detail;
    if (!bodyEl) return;
    const tabChanged = renderedTab !== appState.activeTab;
    const saved = captureScroll();
    if (tabChanged && saved) appState.tabScroll.set(renderedTab, saved);
    const targetTab = appState.activeTab;
    tick().then(() => {
      if (!bodyEl) return;
      restoreScroll(tabChanged ? (appState.tabScroll.get(targetTab) ?? null) : saved);
      renderedTab = targetTab;
    });
  });
</script>

{#if appState.selected && appState.detail}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="detail-body" class:diff-view={appState.activeTab === "diff"} bind:this={bodyEl} onclick={onDetailBodyClick}>
    {#if appState.asking.length > 0}
      <section class="asking">
        <div class="label">⚠ Waiting for you — respond below to resume</div>
        {#each appState.asking as a (a.filename)}
          <article data-asking={a.filename} style="margin-top:.6rem">
            <div class="filename">{a.filename}</div>
            <div class="md">{@html renderMarkdown(a.content)}</div>
            {#if typeof a.command === "string"}
              <textarea class="ask-answer" rows="2" placeholder="Optional reason (sent to the agent if you reject)..." style="margin-top:.4rem"></textarea>
              <div class="row" style="margin-top:.3rem">
                <span class="spacer"></span>
                <button class="ask-reject">Reject</button>
                <button class="ask-approve">Approve &amp; run</button>
              </div>
            {:else}
              <textarea class="ask-answer" rows="3" placeholder="Your answer..." style="margin-top:.4rem"></textarea>
              <div class="row" style="margin-top:.3rem">
                <span class="spacer"></span>
                <button class="ask-resolve">Answer</button>
              </div>
            {/if}
          </article>
        {/each}
      </section>
    {/if}

    {#if appState.activeTab === "diff"}
      {@html renderDiffHtml()}
    {:else if appState.activeTab === "files"}
      {@html renderFilesHtml()}
    {:else if appState.activeTab === "events"}
      {@html renderEventsHtml()}
    {:else if reportsNewestFirst.length > 0}
      {#each reportsNewestFirst as r (r.filename)}
        {@const expanded = isReportExpanded(r)}
        {@const markTo = r.read ? "unread" : "read"}
        <article class="report" class:unread={!r.read} class:collapsed={!expanded} data-report-filename={r.filename}>
          <div class="report-header" data-report-toggle={r.filename}>
            <span class="report-chevron">▾</span>
            <span class="report-filename">{r.filename}</span>
            <span class="report-status {r.read ? 'read' : 'unread'}" data-report-mark={r.filename} data-report-mark-to={markTo} title={r.read ? "クリックで未読にする" : "クリックで既読にする"}><span class="report-status-state">{r.read ? "read" : "unread"}</span><span class="report-status-action">{markTo}?</span></span>
          </div>
          <div class="report-body">
            <div class="md">{@html renderMarkdown(r.content, { anchorPath: `./.worqload-reports/${r.filename}`, anchor: appState.anchor })}</div>
          </div>
        </article>
      {/each}
    {:else}
      <div class="report-empty">No reports yet. The agent submits reports at progress checkpoints.</div>
    {/if}

    {#if appState.feedbackHistory.length > 0}
      <section>
        <h2>Feedback sent</h2>
        {#each appState.feedbackHistory as f (f.filename)}
          <article class="report" class:collapsed={!isFeedbackExpanded(f)} data-feedback-filename={f.filename}>
            <div class="report-header" data-feedback-toggle={f.filename}>
              <span class="report-chevron">▾</span>
              <span class="report-filename">{f.filename}</span>
              <span class="badge badge-{f.status === 'unread' ? 'waiting_human' : 'stopped'}">{f.status}</span>
            </div>
            <div class="report-body">
              <div class="md">{@html renderMarkdown(f.content)}</div>
            </div>
          </article>
        {/each}
      </section>
    {/if}
  </div>
{:else}
  <div class="detail-empty">Select a session, or create a new one.</div>
{/if}
