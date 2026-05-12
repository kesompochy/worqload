<script>
  // The detail pane's scroll body — everything between the header (DetailHeader)
  // and the action area (ActionBar) / composer (Composer): the pending-asking
  // section above the active tab's content. Mounted into #detailBodyMount from
  // main.ts. The Reports tab, the Feedback tab (the "feedback sent" list), and
  // the asking section are rendered natively here off the reactive `appState`
  // (DiffView / FilesView / EventsView render the other tabs). Click handling
  // for the diff, files, and events explorers
  // (collapse, gap expand, file open, copy-path, line anchoring, event
  // expand/collapse), for line anchors inside report markdown, and for the
  // asking buttons is delegated to onDetailBodyClick.
  // (`state` is imported as `appState` — a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { tick } from "svelte";
  import { state as appState, isReportExpanded, isFeedbackExpanded } from "../state.svelte.js";
  import { renderMarkdown } from "../markdown.js";
  import DiffView from "./DiffView.svelte";
  import FilesView from "./FilesView.svelte";
  import EventsView from "./EventsView.svelte";
  import { onDetailBodyClick } from "../handlers.js";

  // Reports are stored oldest-first; the pane shows newest-first.
  const reportsNewestFirst = $derived([...appState.reports].reverse());

  // A streamed event prepends an Events row, the Reports list prepends a
  // freshly arrived report above whatever the user is reading, and expanding a
  // collapsed gap in the Diff inserts rows that may sit above the viewport —
  // all snap the scroll position. To keep the view steady:
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
                <button class="ask-reject">Reject</button>
                <button class="ask-approve">Approve &amp; Run</button>
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
      <DiffView />
    {:else if appState.activeTab === "files"}
      <FilesView />
    {:else if appState.activeTab === "events"}
      <EventsView />
    {:else if appState.activeTab === "feedback"}
      {#if appState.feedbackHistory.length > 0}
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
      {:else}
        <div class="report-empty">No feedback sent yet. Type below to send the agent feedback.</div>
      {/if}
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
  </div>
{:else}
  <div class="detail-empty">Select a session, or create a new one.</div>
{/if}
